import fs from "fs";
import os from "os";
import path from "path";
import { LocalDeadLetterStore } from "../storage/LocalDeadLetterStore";
import { FlowTriggerClient, verifyWebhookSignature } from "../engine/FlowTriggerClient";
import { ExecutionEngine } from "../engine/ExecutionEngine";
import { GeminiClient } from "../engine/GeminiClient";
import { OpenAICompatClient } from "../engine/OpenAICompatClient";
import { PromptRenderer } from "../engine/PromptRenderer";
import { TaskDefinitionSchema } from "../scheduler/types";

const baseOutput = {
  type: "webhook" as const,
  url: "https://example.com/callback",
};

describe("LocalDeadLetterStore", () => {
  let tmpDir: string;
  let dlqPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routineweave-dlq-test-"));
    dlqPath = path.join(tmpDir, "nested", "dead-letters.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles non-existent file cleanly for list, markReplayed, and purgeReplayed", () => {
    const store = new LocalDeadLetterStore(dlqPath);
    expect(store.getFilePath()).toBe(path.resolve(dlqPath));
    expect(store.list()).toEqual([]);
    expect(store.list({ includeReplayed: true })).toEqual([]);
    expect(store.markReplayed("missing-id")).toBe(false);
    expect(store.purgeReplayed()).toBe(0);
  });

  it("validates required constructor and enqueue fields", () => {
    expect(() => new LocalDeadLetterStore("")).toThrow(/non-empty filePath/i);
    expect(() => new LocalDeadLetterStore("   ")).toThrow(/non-empty filePath/i);

    const store = new LocalDeadLetterStore(dlqPath);
    expect(() =>
      store.enqueue({
        id: "",
        taskId: "task_a",
        payload: {},
        error: "boom",
        failedAt: "2026-11-23T10:00:00.000Z",
      }),
    ).toThrow(/non-empty id/i);

    expect(() =>
      store.enqueue({
        id: "dlq-1",
        taskId: "   ",
        payload: {},
        error: "boom",
        failedAt: "2026-11-23T10:00:00.000Z",
      }),
    ).toThrow(/non-empty taskId/i);
  });

  it("persists enqueue, list filters, markReplayed, and purgeReplayed across instances", () => {
    const writer = new LocalDeadLetterStore(dlqPath);

    const e1 = writer.enqueue({
      id: "dlq-1",
      taskId: "morning_briefing",
      flowId: "daily_briefing",
      payload: { trigger_id: "trig-1", inputs: { region: "us-west" } },
      error: "503 Service Unavailable",
      failedAt: "2026-11-23T07:00:00.000Z",
    });
    const e2 = writer.enqueue({
      id: "dlq-2",
      taskId: "morning_briefing",
      flowId: "daily_briefing",
      payload: { trigger_id: "trig-2" },
      error: "Connection refused",
      failedAt: "2026-11-23T08:00:00.000Z",
    });
    writer.enqueue({
      id: "dlq-3",
      taskId: "local_digest",
      payload: { executionMode: "llm", model: "qwen2.5-3b-instruct" },
      error: "Timeout after 5000ms",
      failedAt: "2026-11-23T09:00:00.000Z",
    });

    expect(e1.replayed).toBe(false);
    expect(e2.replayed).toBe(false);

    // Re-open with a fresh instance to verify JSONL disk persistence
    const reader = new LocalDeadLetterStore(dlqPath);
    expect(reader.list()).toHaveLength(3);
    expect(reader.list({ taskId: "morning_briefing" })).toHaveLength(2);
    expect(reader.list({ taskId: "local_digest" })).toHaveLength(1);
    expect(reader.list({ taskId: "nonexistent" })).toEqual([]);

    // Mark dlq-1 as replayed with an explicit timestamp
    expect(reader.markReplayed("dlq-1", "2026-11-23T10:15:00.000Z")).toBe(true);
    expect(reader.markReplayed("unknown-id")).toBe(false);

    // Re-open again and verify default list excludes replayed while includeReplayed shows all
    const reader2 = new LocalDeadLetterStore(dlqPath);
    const pending = reader2.list();
    expect(pending.map((entry) => entry.id)).toEqual(["dlq-2", "dlq-3"]);

    const allWithReplayed = reader2.list({ includeReplayed: true });
    expect(allWithReplayed).toHaveLength(3);
    const replayedEntry = allWithReplayed.find((entry) => entry.id === "dlq-1");
    expect(replayedEntry).toMatchObject({
      id: "dlq-1",
      taskId: "morning_briefing",
      flowId: "daily_briefing",
      replayed: true,
      replayedAt: "2026-11-23T10:15:00.000Z",
    });

    // Filtered taskId + includeReplayed
    expect(
      reader2.list({ taskId: "morning_briefing", includeReplayed: false }).map((e) => e.id),
    ).toEqual(["dlq-2"]);
    expect(
      reader2.list({ taskId: "morning_briefing", includeReplayed: true }).map((e) => e.id),
    ).toEqual(["dlq-1", "dlq-2"]);

    // Purge replayed entries and verify persistence on fresh instance
    expect(reader2.purgeReplayed()).toBe(1);
    expect(reader2.purgeReplayed()).toBe(0);

    const reader3 = new LocalDeadLetterStore(dlqPath);
    expect(reader3.list({ includeReplayed: true }).map((e) => e.id)).toEqual(["dlq-2", "dlq-3"]);
  });

  it("skips corrupt and malformed JSONL lines gracefully", () => {
    const store = new LocalDeadLetterStore(dlqPath);
    store.enqueue({
      id: "dlq-ok-1",
      taskId: "task_a",
      payload: { step: 1 },
      error: "network error",
      failedAt: "2026-11-23T11:00:00.000Z",
    });
    fs.appendFileSync(dlqPath, "{corrupt-json\n{\"missingFields\":true}\n", "utf-8");
    store.enqueue({
      id: "dlq-ok-2",
      taskId: "task_b",
      flowId: "flow_b",
      payload: { step: 2 },
      error: "502 Bad Gateway",
      failedAt: "2026-11-23T11:05:00.000Z",
    });

    const entries = store.list();
    expect(entries.map((e) => e.id)).toEqual(["dlq-ok-1", "dlq-ok-2"]);
  });
});

describe("FlowTriggerClient HMAC-SHA256 webhook signing", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("attaches valid X-Weave-Signature header verified by verifyWebhookSignature", async () => {
    const secret = "weave-super-secret-signing-key";
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 202,
      statusText: "Accepted",
      text: async () => JSON.stringify({ run_id: "run-sig-1" }),
    } as Response);

    const client = new FlowTriggerClient({
      defaultMaxRetries: 0,
      defaultRetryBaseDelayMs: 1,
      signingSecret: secret,
    });

    const result = await client.dispatch({
      taskId: "signed_task",
      triggerId: "trig-signed-1",
      firedAt: "2026-11-23T12:00:00.000Z",
      config: {
        endpointUrl: "http://127.0.0.1:8787/v1/triggers/webhook",
        flowId: "secure_flow",
        inputs: { mode: "edge" },
      },
    });

    expect(result.status).toBe(202);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    const signature = headers["X-Weave-Signature"];

    expect(signature).toBeDefined();
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);

    // Reject tampered body, wrong secret, and malformed signatures
    expect(verifyWebhookSignature(`${body} `, signature, secret)).toBe(false);
    expect(verifyWebhookSignature(body.replace("edge", "tampered"), signature, secret)).toBe(false);
    expect(verifyWebhookSignature(body, signature, "wrong-secret")).toBe(false);
    expect(verifyWebhookSignature(body, "md5=deadbeef", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=short", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "", secret)).toBe(false);
    expect(verifyWebhookSignature(body, signature, "")).toBe(false);
  });

  it("omits X-Weave-Signature header when signingSecret is not configured", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "ok",
    } as Response);

    const client = new FlowTriggerClient({
      defaultMaxRetries: 0,
      defaultRetryBaseDelayMs: 1,
    });

    await client.dispatch({
      taskId: "unsigned_task",
      config: {
        endpointUrl: "http://127.0.0.1:8787/v1/triggers/webhook",
        flowId: "open_flow",
      },
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Weave-Signature"]).toBeUndefined();
  });
});

describe("ExecutionEngine automatic LocalDeadLetterStore hook", () => {
  let tmpDir: string;
  let dlqPath: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routineweave-engine-dlq-"));
    dlqPath = path.join(tmpDir, "dlq.jsonl");
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enqueues failed flow_trigger and llm runs into deadLetterStore and skips successes", async () => {
    const geminiGenerate = jest.fn();
    const geminiMock = { generate: geminiGenerate } as unknown as GeminiClient;
    const deadLetterStore = new LocalDeadLetterStore(dlqPath);

    const engine = new ExecutionEngine(geminiMock, new PromptRenderer(), {
      flowTriggerClient: new FlowTriggerClient({
        defaultMaxRetries: 0,
        defaultRetryBaseDelayMs: 1,
      }),
      openAICompatClient: new OpenAICompatClient({
        maxRetries: 0,
        retryBaseDelayMs: 1,
      }),
      deadLetterStore,
    });

    const flowTask = TaskDefinitionSchema.parse({
      task_name: "edge_webhook_sync",
      schedule: "0 * * * *",
      executionMode: "flow_trigger",
      max_retries: 0,
      input: { source: "pi-node-1" },
      flowTrigger: {
        endpointUrl: "http://127.0.0.1:8787/v1/triggers/webhook",
        flowId: "sync_flow",
        inputs: { priority: "high" },
      },
      output: baseOutput,
    });

    // 1. Successful flow_trigger run should NOT enqueue a dead letter
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 202,
      statusText: "Accepted",
      text: async () => JSON.stringify({ run_id: "r-ok-1" }),
    } as Response);
    const okFlow = await engine.execute(flowTask);
    expect(okFlow.success).toBe(true);
    expect(deadLetterStore.list()).toHaveLength(0);

    // 2. Failed flow_trigger run MUST enqueue a dead letter
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "WeaveOS restarting",
    } as Response);
    const failedFlow = await engine.execute(flowTask);
    expect(failedFlow.success).toBe(false);

    // 3. Failed openai_compat llm run MUST enqueue a dead letter
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "model crashed",
    } as Response);
    const openAITask = TaskDefinitionSchema.parse({
      task_name: "local_llm_summary",
      schedule: "0 9 * * *",
      prompt: "Summarize {{topic}}",
      model: "qwen2.5-3b-instruct",
      provider: "openai_compat",
      max_retries: 0,
      providerConfig: { baseUrl: "http://127.0.0.1:8080" },
      input: { topic: "Edge Ops" },
      output: baseOutput,
    });
    const failedOpenAI = await engine.execute(openAITask);
    expect(failedOpenAI.success).toBe(false);

    // 4. Failed gemini llm run MUST enqueue a dead letter
    geminiGenerate.mockRejectedValueOnce(new Error("Gemini quota exceeded"));
    const geminiTask = TaskDefinitionSchema.parse({
      task_name: "gemini_digest",
      schedule: "0 10 * * *",
      prompt: "Digest today",
      model: "gemini-2.5-flash",
      provider: "gemini",
      max_retries: 0,
      output: baseOutput,
    });
    const failedGemini = await engine.execute(geminiTask);
    expect(failedGemini.success).toBe(false);

    // Verify all 3 failures were persisted to disk
    const persisted = new LocalDeadLetterStore(dlqPath).list();
    expect(persisted).toHaveLength(3);

    expect(persisted[0]).toMatchObject({
      taskId: "edge_webhook_sync",
      flowId: "sync_flow",
      replayed: false,
      payload: {
        executionMode: "flow_trigger",
        endpointUrl: "http://127.0.0.1:8787/v1/triggers/webhook",
        flowId: "sync_flow",
        inputs: { source: "pi-node-1", priority: "high" },
      },
    });
    expect(persisted[0].error).toContain("503");

    expect(persisted[1]).toMatchObject({
      taskId: "local_llm_summary",
      replayed: false,
      payload: {
        executionMode: "llm",
        provider: "openai_compat",
        model: "qwen2.5-3b-instruct",
      },
    });
    expect(persisted[1].flowId).toBeUndefined();
    expect(persisted[1].error).toContain("500");

    expect(persisted[2]).toMatchObject({
      taskId: "gemini_digest",
      replayed: false,
      error: "Gemini quota exceeded",
      payload: {
        executionMode: "llm",
        provider: "gemini",
        model: "gemini-2.5-flash",
      },
    });
  });

  it("does not crash execute() when deadLetterStore.enqueue throws", async () => {
    const geminiMock = {
      generate: jest.fn().mockRejectedValueOnce(new Error("primary failure")),
    } as unknown as GeminiClient;
    const brokenDlq = {
      enqueue: jest.fn().mockImplementation(() => {
        throw new Error("disk read-only");
      }),
    } as unknown as LocalDeadLetterStore;

    const engine = new ExecutionEngine(geminiMock, new PromptRenderer(), {
      deadLetterStore: brokenDlq,
    });

    const task = TaskDefinitionSchema.parse({
      task_name: "resilient_failure_task",
      schedule: "0 12 * * *",
      prompt: "Hello",
      output: baseOutput,
    });

    const result = await engine.execute(task);
    expect(result.success).toBe(false);
    expect(result.error).toBe("primary failure");
  });
});
