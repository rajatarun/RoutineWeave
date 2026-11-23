import fs from "fs";
import os from "os";
import path from "path";
import { TaskLoader } from "../scheduler/TaskLoader";
import { TaskDefinitionSchema } from "../scheduler/types";
import { FlowTriggerClient } from "../engine/FlowTriggerClient";
import { OpenAICompatClient } from "../engine/OpenAICompatClient";
import { ExecutionEngine } from "../engine/ExecutionEngine";
import { GeminiClient } from "../engine/GeminiClient";
import { PromptRenderer } from "../engine/PromptRenderer";

const baseOutput = {
  type: "webhook" as const,
  url: "https://example.com/callback",
};

describe("TaskDefinitionSchema & TaskLoader (flow_trigger & openai_compat)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routineweave-flow-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates a flow_trigger task without requiring a prompt", () => {
    const raw = {
      task_name: "morning_briefing_flow",
      schedule: "0 7 * * *",
      executionMode: "flow_trigger",
      flowTrigger: {
        endpointUrl: "http://127.0.0.1:8787/api/triggers",
        flowId: "daily_briefing_v1",
        authTokenEnv: "WEAVE_TRIGGER_TOKEN",
        inputs: { region: "us-west", verbose: true },
        timeoutMs: 15_000,
      },
      output: baseOutput,
    };

    const parsed = TaskDefinitionSchema.parse(raw);
    expect(parsed.executionMode).toBe("flow_trigger");
    expect(parsed.flowTrigger?.flowId).toBe("daily_briefing_v1");
    expect(parsed.flowTrigger?.timeoutMs).toBe(15_000);
    expect(parsed.prompt).toBe("");
  });

  it("rejects flow_trigger task missing flowTrigger config", () => {
    const raw = {
      task_name: "missing_trigger_config",
      schedule: "0 7 * * *",
      executionMode: "flow_trigger",
      output: baseOutput,
    };

    const result = TaskDefinitionSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.join(".") === "flowTrigger")).toBe(true);
    }
  });

  it("rejects flow_trigger task with invalid endpointUrl", () => {
    const raw = {
      task_name: "bad_url_flow",
      schedule: "0 7 * * *",
      executionMode: "flow_trigger",
      flowTrigger: {
        endpointUrl: "not-a-url",
        flowId: "daily_briefing_v1",
      },
      output: baseOutput,
    };

    const result = TaskDefinitionSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("rejects llm task with empty prompt", () => {
    const raw = {
      task_name: "empty_prompt_llm",
      schedule: "0 7 * * *",
      executionMode: "llm",
      prompt: "   ",
      output: baseOutput,
    };

    const result = TaskDefinitionSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.join(".") === "prompt")).toBe(true);
    }
  });

  it("loads flow_trigger and openai_compat tasks via TaskLoader", () => {
    const flowTask = {
      task_name: "pi_sensor_sync",
      schedule: "*/5 * * * *",
      executionMode: "flow_trigger",
      flowTrigger: {
        endpointUrl: "http://127.0.0.1:8787/triggers",
        flowId: "sensor_sync",
      },
      output: baseOutput,
    };
    const localLlmTask = {
      task_name: "offline_summary",
      schedule: "0 8 * * *",
      prompt: "Summarize local notes for {{topic}}",
      model: "qwen2.5-3b-instruct",
      provider: "openai_compat",
      providerConfig: {
        baseUrl: "http://127.0.0.1:8080",
        temperature: 0.2,
        maxTokens: 512,
      },
      output: baseOutput,
    };

    fs.writeFileSync(path.join(tmpDir, "flow.json"), JSON.stringify(flowTask));
    fs.writeFileSync(path.join(tmpDir, "local_llm.json"), JSON.stringify(localLlmTask));

    const loader = new TaskLoader(tmpDir);
    const loaded = loader.loadAll();
    expect(loaded).toHaveLength(2);
    expect(loaded.find((t) => t.task_name === "pi_sensor_sync")?.executionMode).toBe("flow_trigger");
    expect(loaded.find((t) => t.task_name === "offline_summary")?.provider).toBe("openai_compat");
  });
});

describe("FlowTriggerClient (weave-trigger-v1)", () => {
  let fetchSpy: jest.SpyInstance;
  const ENV_KEY = "TEST_WEAVE_FLOW_TRIGGER_TOKEN";

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
    jest.restoreAllMocks();
  });

  it("POSTs exact weave-trigger-v1 JSON payload with env-sourced Bearer token", async () => {
    process.env[ENV_KEY] = "secret-trigger-token-xyz";

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 202,
      statusText: "Accepted",
      text: async () => JSON.stringify({ accepted: true, run_id: "run-42" }),
    } as Response);

    const writtenLogs: string[] = [];
    const stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writtenLogs.push(String(chunk));
      return true;
    });

    const client = new FlowTriggerClient({ defaultRetryBaseDelayMs: 1 });
    const response = await client.dispatch({
      taskId: "morning_briefing",
      triggerId: "trig-001",
      firedAt: "2026-11-23T07:00:00.000Z",
      extraInputs: { source: "cron", city: "Seattle" },
      config: {
        endpointUrl: "http://127.0.0.1:8787/api/v1/triggers",
        flowId: "briefing_flow",
        authTokenEnv: ENV_KEY,
        inputs: { city: "Portland", priority: "high" },
        timeoutMs: 5000,
      },
    });

    stdoutSpy.mockRestore();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/v1/triggers");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer secret-trigger-token-xyz",
    });

    const sentPayload = JSON.parse(init.body as string);
    expect(sentPayload).toEqual({
      schema: "weave-trigger-v1",
      trigger_id: "trig-001",
      task_id: "morning_briefing",
      flow_id: "briefing_flow",
      fired_at: "2026-11-23T07:00:00.000Z",
      inputs: {
        source: "cron",
        city: "Portland",
        priority: "high",
      },
    });

    expect(response.status).toBe(202);
    expect(response.triggerId).toBe("trig-001");
    expect(response.flowId).toBe("briefing_flow");
    expect(response.json).toEqual({ accepted: true, run_id: "run-42" });

    // Ensure secret token is never leaked into stdout logs
    expect(writtenLogs.join("")).not.toContain("secret-trigger-token-xyz");
  });

  it("throws immediately when authTokenEnv is specified but unset in process.env", async () => {
    const client = new FlowTriggerClient({ defaultRetryBaseDelayMs: 1 });
    await expect(
      client.dispatch({
        taskId: "missing_auth_task",
        config: {
          endpointUrl: "http://127.0.0.1:8787/triggers",
          flowId: "secure_flow",
          authTokenEnv: ENV_KEY,
        },
      }),
    ).rejects.toThrow(`Environment variable "${ENV_KEY}" is not set`);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries transient 503 errors and succeeds on subsequent attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "overloaded",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({ status: "queued" }),
      } as Response);

    const client = new FlowTriggerClient({ defaultMaxRetries: 2, defaultRetryBaseDelayMs: 1 });
    const res = await client.dispatch({
      taskId: "retry_task",
      config: {
        endpointUrl: "http://127.0.0.1:8787/triggers",
        flowId: "resilient_flow",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "queued" });
  });

  it("does not retry non-retryable 400 client errors", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "invalid flow_id",
    } as Response);

    const client = new FlowTriggerClient({ defaultMaxRetries: 3, defaultRetryBaseDelayMs: 1 });
    await expect(
      client.dispatch({
        taskId: "bad_req_task",
        config: {
          endpointUrl: "http://127.0.0.1:8787/triggers",
          flowId: "unknown_flow",
        },
      }),
    ).rejects.toThrow("Flow trigger endpoint responded with status 400: Bad Request - invalid flow_id");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAICompatClient", () => {
  let fetchSpy: jest.SpyInstance;
  const API_KEY_ENV = "TEST_LOCAL_OPENAI_KEY";

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
    delete process.env[API_KEY_ENV];
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_COMPAT_BASE_URL;
  });

  afterEach(() => {
    delete process.env[API_KEY_ENV];
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_COMPAT_BASE_URL;
    jest.restoreAllMocks();
  });

  it("executes chat completion against local llama.cpp/Ollama without any API key", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        model: "qwen2.5-3b-instruct",
        choices: [{ message: { role: "assistant", content: "All systems nominal." } }],
        usage: { prompt_tokens: 18, completion_tokens: 4 },
      }),
    } as Response);

    const client = new OpenAICompatClient({ retryBaseDelayMs: 1 });
    const res = await client.generate({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5-3b-instruct",
      systemPrompt: "You are a concise local assistant.",
      prompt: "Report status.",
      temperature: 0.1,
      maxTokens: 128,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: "qwen2.5-3b-instruct",
      messages: [
        { role: "system", content: "You are a concise local assistant." },
        { role: "user", content: "Report status." },
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: 128,
    });

    expect(res).toEqual({
      text: "All systems nominal.",
      model: "qwen2.5-3b-instruct",
      promptTokens: 18,
      outputTokens: 4,
      groundingUsed: false,
    });
  });

  it("normalizes baseUrl ending with /v1 and attaches optional env-sourced Bearer key", async () => {
    process.env[API_KEY_ENV] = "local-vllm-key";

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        choices: [{ message: { content: "Done." } }],
      }),
    } as Response);

    const client = new OpenAICompatClient({ retryBaseDelayMs: 1 });
    const res = await client.generate({
      baseUrl: "http://127.0.0.1:8000/v1/",
      apiKeyEnv: API_KEY_ENV,
      model: "llama-3.2-3b",
      prompt: "Hello",
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer local-vllm-key",
    });
    expect(res.text).toBe("Done.");
  });

  it("retries 502 errors and throws cleanly when all retries fail", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "upstream loading model",
    } as Response);

    const client = new OpenAICompatClient({ maxRetries: 1, retryBaseDelayMs: 1 });
    await expect(
      client.generate({
        baseUrl: "http://127.0.0.1:8080",
        model: "qwen2.5",
        prompt: "ping",
      }),
    ).rejects.toThrow("OpenAI-compatible endpoint responded with status 502: Bad Gateway");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("ExecutionEngine integration (flow_trigger & openai_compat)", () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("dispatches flow_trigger task via FlowTriggerClient without invoking GeminiClient", async () => {
    const geminiMock = {
      generate: jest.fn(),
    } as unknown as GeminiClient;

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 202,
      statusText: "Accepted",
      text: async () => JSON.stringify({ run_id: "flow-run-99" }),
    } as Response);

    const engine = new ExecutionEngine(geminiMock, new PromptRenderer(), {
      flowTriggerClient: new FlowTriggerClient({ defaultRetryBaseDelayMs: 1 }),
    });

    const task = TaskDefinitionSchema.parse({
      task_name: "nightly_backup_flow",
      schedule: "0 2 * * *",
      executionMode: "flow_trigger",
      flowTrigger: {
        endpointUrl: "http://127.0.0.1:8787/triggers",
        flowId: "nightly_backup",
        inputs: { target: "nas" },
      },
      output: baseOutput,
    });

    const result = await engine.execute(task);
    expect(result.success).toBe(true);
    expect(result.structured_result).toEqual({ run_id: "flow-run-99" });
    expect(geminiMock.generate).not.toHaveBeenCalled();
  });

  it("reports structured error when flow_trigger HTTP dispatch fails", async () => {
    const geminiMock = {
      generate: jest.fn(),
    } as unknown as GeminiClient;

    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "scheduler down",
    } as Response);

    const engine = new ExecutionEngine(geminiMock, new PromptRenderer(), {
      flowTriggerClient: new FlowTriggerClient({ defaultMaxRetries: 1, defaultRetryBaseDelayMs: 1 }),
    });

    const task = TaskDefinitionSchema.parse({
      task_name: "failing_flow",
      schedule: "0 2 * * *",
      executionMode: "flow_trigger",
      max_retries: 1,
      flowTrigger: {
        endpointUrl: "http://127.0.0.1:8787/triggers",
        flowId: "broken_flow",
      },
      output: baseOutput,
    });

    const result = await engine.execute(task);
    expect(result.success).toBe(false);
    expect(result.error).toContain("500: Internal Server Error");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(geminiMock.generate).not.toHaveBeenCalled();
  });

  it("executes provider: openai_compat task with rendered prompt without GeminiClient", async () => {
    const geminiMock = {
      generate: jest.fn(),
    } as unknown as GeminiClient;

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        model: "qwen2.5-3b-instruct",
        choices: [{ message: { content: "Rendered offline answer for Edge AI" } }],
        usage: { prompt_tokens: 10, completion_tokens: 6 },
      }),
    } as Response);

    const engine = new ExecutionEngine(geminiMock, new PromptRenderer(), {
      openAICompatClient: new OpenAICompatClient({ retryBaseDelayMs: 1 }),
    });

    const task = TaskDefinitionSchema.parse({
      task_name: "local_digest",
      schedule: "0 9 * * *",
      prompt: "Write a brief digest about {{topic}}.",
      model: "qwen2.5-3b-instruct",
      provider: "openai_compat",
      providerConfig: {
        baseUrl: "http://127.0.0.1:8080",
      },
      input: { topic: "Edge AI" },
      output: baseOutput,
    });

    const result = await engine.execute(task);
    expect(result.success).toBe(true);
    expect(result.result).toBe("Rendered offline answer for Edge AI");
    expect(geminiMock.generate).not.toHaveBeenCalled();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content).toBe("Write a brief digest about Edge AI.");
  });
});
