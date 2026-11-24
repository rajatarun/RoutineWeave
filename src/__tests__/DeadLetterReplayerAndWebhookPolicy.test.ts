import fs from "fs";
import os from "os";
import path from "path";
import { FlowTriggerClient } from "../engine/FlowTriggerClient";
import { WebhookPolicyError, WebhookPolicyGuard } from "../engine/WebhookPolicyGuard";
import { DeadLetterReplayer } from "../storage/DeadLetterReplayer";
import { LocalDeadLetterStore } from "../storage/LocalDeadLetterStore";

describe("WebhookPolicyGuard", () => {
  it("allows https URLs and localhost http URLs by default", () => {
    const guard = new WebhookPolicyGuard();

    expect(guard.validateUrl("https://hooks.example.com/trigger")).toEqual({
      allowed: true,
    });
    expect(guard.validateUrl("http://127.0.0.1:8080/v1/flows/run")).toEqual({
      allowed: true,
    });
    expect(guard.validateUrl("http://localhost:9000/trigger")).toEqual({
      allowed: true,
    });
    expect(guard.validateUrl("http://[::1]:8080/trigger")).toEqual({
      allowed: true,
    });
  });

  it("blocks cloud metadata IPs, non-HTTP(S) schemes, and non-localhost plain HTTP", () => {
    const guard = new WebhookPolicyGuard();

    const metadata = guard.validateUrl("http://169.254.169.254/latest/meta-data/");
    expect(metadata.allowed).toBe(false);
    expect(metadata.reason).toMatch(/metadata|link-local/i);

    const metadataHttps = guard.validateUrl("https://169.254.169.254/latest/meta-data/");
    expect(metadataHttps.allowed).toBe(false);

    const fileUrl = guard.validateUrl("file:///etc/passwd");
    expect(fileUrl.allowed).toBe(false);
    expect(fileUrl.reason).toMatch(/scheme/i);

    const plainHttp = guard.validateUrl("http://api.example.com/webhook");
    expect(plainHttp.allowed).toBe(false);
    expect(plainHttp.reason).toMatch(/plain http/i);
  });

  it("enforces allowLocalhostHttp=false, allowedHosts, and blockedHosts", () => {
    const strictGuard = new WebhookPolicyGuard({
      allowLocalhostHttp: false,
      allowedHosts: ["hooks.trusted.io", "*.weave.local"],
      blockedHosts: ["bad.weave.local"],
    });

    expect(strictGuard.validateUrl("http://localhost:8080/hook").allowed).toBe(false);
    expect(strictGuard.validateUrl("https://hooks.trusted.io/v1").allowed).toBe(true);
    expect(strictGuard.validateUrl("https://edge.weave.local/v1").allowed).toBe(true);
    expect(strictGuard.validateUrl("https://bad.weave.local/v1").allowed).toBe(false);
    expect(strictGuard.validateUrl("https://other.example.com/v1").allowed).toBe(false);
  });

  it("blocks IPv4-mapped IPv6, unspecified addresses, and numeric/hex/octal IPv4 SSRF vectors", () => {
    const guard = new WebhookPolicyGuard();
    const strictGuard = new WebhookPolicyGuard({ allowLocalhostHttp: false });

    const ssrfVectors = [
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "https://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "https://[::ffff:a9fe:a9fe]/",
      "http://[::ffff:0.0.0.0]/",
      "http://0.0.0.0/",
      "https://0.0.0.0/",
      "http://[::]/",
      "https://[::]/",
      "http://2852039166/",
      "https://2852039166/",
      "http://0xa9fea9fe/",
      "https://0xa9fea9fe/",
      "http://0251.0376.0251.0376/",
      "https://0251.0376.0251.0376/",
    ];

    for (const url of ssrfVectors) {
      const decision = guard.validateUrl(url);
      expect(decision.allowed).toBe(false);
    }

    // IPv4-mapped loopback must be blocked when allowLocalhostHttp=false
    expect(strictGuard.validateUrl("http://[::ffff:127.0.0.1]/hook").allowed).toBe(false);
    expect(strictGuard.validateUrl("http://[::ffff:7f00:1]/hook").allowed).toBe(false);
  });
});

describe("FlowTriggerClient with WebhookPolicyGuard", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("refuses blocked URLs fail-closed without calling fetch", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new FlowTriggerClient({
      policyGuard: new WebhookPolicyGuard(),
    });

    await expect(
      client.dispatch({
        taskId: "task-ssrf",
        config: {
          endpointUrl: "http://169.254.169.254/latest/meta-data/",
          flowId: "daily_briefing",
        },
      }),
    ).rejects.toThrow(WebhookPolicyError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches normally for allowed URLs", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ run_id: "run-123" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new FlowTriggerClient({
      policyGuard: new WebhookPolicyGuard({ allowedHosts: ["127.0.0.1"] }),
    });

    const resp = await client.dispatch({
      taskId: "task-ok",
      config: {
        endpointUrl: "http://127.0.0.1:8787/v1/flows/trigger",
        flowId: "morning_summary",
      },
    });

    expect(resp.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("DeadLetterReplayer", () => {
  let tmpDir: string;
  let dlqPath: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routineweave-replayer-test-"));
    dlqPath = path.join(tmpDir, "dlq.jsonl");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("replays pending entries, retries transient failures with backoff, marks replayed, and skips already-replayed entries", async () => {
    const store = new LocalDeadLetterStore(dlqPath);
    store.enqueue({
      id: "dlq-1",
      taskId: "task-a",
      flowId: "flow-a",
      payload: {
        endpointUrl: "https://hooks.example.com/a",
        flowId: "flow-a",
        inputs: { region: "us-west" },
      },
      error: "503 Service Unavailable",
      failedAt: "2026-11-24T01:00:00.000Z",
    });
    store.enqueue({
      id: "dlq-2",
      taskId: "task-b",
      flowId: "flow-b",
      payload: {
        endpointUrl: "https://hooks.example.com/b",
        flowId: "flow-b",
      },
      error: "502 Bad Gateway",
      failedAt: "2026-11-24T01:05:00.000Z",
    });
    // Mark dlq-2 as already replayed so it must be skipped
    store.markReplayed("dlq-2");

    let callCount = 0;
    const fetchMock = jest.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount < 3) {
        return {
          ok: false,
          status: 503,
          text: async () => "temporary outage",
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const sleepDelays: number[] = [];
    const client = new FlowTriggerClient({
      policyGuard: new WebhookPolicyGuard(),
    });
    const replayer = new DeadLetterReplayer(store, client, {
      maxAttempts: 4,
      backoffMs: 25,
      sleepFn: async (ms: number) => {
        sleepDelays.push(ms);
      },
    });

    const summary = await replayer.replayPending();
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results).toEqual([{ id: "dlq-1", ok: true, attempts: 3 }]);
    expect(sleepDelays).toEqual([25, 50]);

    // Store now has 0 pending entries
    expect(store.list({ includeReplayed: false })).toEqual([]);
    const allEntries = store.list({ includeReplayed: true });
    expect(allEntries.every((e) => e.replayed)).toBe(true);

    // Second replayPending call is a clean no-op
    const second = await replayer.replayPending();
    expect(second).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    });
  });

  it("stops immediately on non-retryable WebhookPolicyError and keeps entry un-replayed", async () => {
    const store = new LocalDeadLetterStore(dlqPath);
    store.enqueue({
      id: "dlq-blocked",
      taskId: "task-blocked",
      flowId: "flow-blocked",
      payload: {
        endpointUrl: "http://169.254.169.254/latest/meta-data/",
        flowId: "flow-blocked",
      },
      error: "initial failure",
      failedAt: "2026-11-24T02:00:00.000Z",
    });

    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const sleepDelays: number[] = [];
    const client = new FlowTriggerClient({
      policyGuard: new WebhookPolicyGuard(),
    });
    const replayer = new DeadLetterReplayer(store, client, {
      maxAttempts: 3,
      backoffMs: 10,
      sleepFn: async (ms: number) => {
        sleepDelays.push(ms);
      },
    });

    const summary = await replayer.replayPending();
    expect(summary.attempted).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.results[0].attempts).toBe(1);
    expect(summary.results[0].error).toMatch(/blocked by policy/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sleepDelays).toEqual([]);
    expect(store.list({ includeReplayed: false })).toHaveLength(1);
  });
});
