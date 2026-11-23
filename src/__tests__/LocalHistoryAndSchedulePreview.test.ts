import fs from "fs";
import os from "os";
import path from "path";
import { LocalHistoryStore } from "../storage/LocalHistoryStore";
import {
  computeNextRuns,
  dryRunSchedule,
  InvalidCronExpressionError,
} from "../scheduler/SchedulePreview";
import { TaskDefinitionSchema } from "../scheduler/types";
import { ExecutionEngine } from "../engine/ExecutionEngine";
import { FlowTriggerClient } from "../engine/FlowTriggerClient";
import { GeminiClient } from "../engine/GeminiClient";
import { OpenAICompatClient } from "../engine/OpenAICompatClient";
import { PromptRenderer } from "../engine/PromptRenderer";

const baseOutput = {
  type: "webhook" as const,
  url: "https://example.com/callback",
};

describe("LocalHistoryStore", () => {
  let tmpDir: string;
  let historyPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routineweave-history-test-"));
    historyPath = path.join(tmpDir, "nested", "history.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty runs and zeroed stats when file does not exist yet", () => {
    const store = new LocalHistoryStore(historyPath);
    expect(store.listRuns()).toEqual([]);
    expect(store.getStats()).toEqual({
      total: 0,
      success: 0,
      error: 0,
      avgLatencyMs: 0,
    });
  });

  it("persists JSONL runs across separate store instances and filters accurately", () => {
    const writer = new LocalHistoryStore(historyPath);

    writer.recordRun({
      taskId: "morning_briefing",
      executionMode: "flow_trigger",
      status: "success",
      latencyMs: 120,
      timestamp: "2026-11-23T07:00:00.000Z",
      triggerId: "trig-1",
      flowId: "daily_briefing",
    });
    writer.recordRun({
      taskId: "morning_briefing",
      executionMode: "flow_trigger",
      status: "error",
      latencyMs: 240,
      timestamp: "2026-11-23T08:00:00.000Z",
      flowId: "daily_briefing",
      error: "503 Service Unavailable",
    });
    writer.recordRun({
      taskId: "local_summary",
      executionMode: "llm",
      status: "success",
      latencyMs: 60,
      timestamp: "2026-11-23T09:00:00.000Z",
      provider: "openai_compat",
      model: "qwen2.5-3b-instruct",
    });

    // Re-open with a fresh instance to verify on-disk persistence
    const reader = new LocalHistoryStore(historyPath);
    const all = reader.listRuns();
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({
      taskId: "morning_briefing",
      executionMode: "flow_trigger",
      status: "success",
      triggerId: "trig-1",
      flowId: "daily_briefing",
      latencyMs: 120,
    });
    expect(all[1]).toMatchObject({
      taskId: "morning_briefing",
      status: "error",
      error: "503 Service Unavailable",
    });
    expect(all[2]).toMatchObject({
      taskId: "local_summary",
      executionMode: "llm",
      provider: "openai_compat",
      model: "qwen2.5-3b-instruct",
    });

    // Filtering by taskId
    expect(reader.listRuns({ taskId: "morning_briefing" })).toHaveLength(2);
    expect(reader.listRuns({ taskId: "local_summary" })).toHaveLength(1);
    expect(reader.listRuns({ taskId: "nonexistent" })).toEqual([]);

    // Filtering by status
    expect(reader.listRuns({ status: "success" })).toHaveLength(2);
    expect(reader.listRuns({ status: "error" })).toHaveLength(1);

    // Combined filters + limit
    expect(reader.listRuns({ taskId: "morning_briefing", status: "error" })).toHaveLength(1);
    const limited = reader.listRuns({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].timestamp).toBe("2026-11-23T08:00:00.000Z");
    expect(limited[1].timestamp).toBe("2026-11-23T09:00:00.000Z");
    expect(reader.listRuns({ limit: 0 })).toEqual([]);

    // Stats (overall and per-task)
    expect(reader.getStats()).toEqual({
      total: 3,
      success: 2,
      error: 1,
      avgLatencyMs: 140,
    });
    expect(reader.getStats("morning_briefing")).toEqual({
      total: 2,
      success: 1,
      error: 1,
      avgLatencyMs: 180,
    });
    expect(reader.getStats("local_summary")).toEqual({
      total: 1,
      success: 1,
      error: 0,
      avgLatencyMs: 60,
    });
  });

  it("skips corrupt JSONL lines gracefully without losing valid records", () => {
    const store = new LocalHistoryStore(historyPath);
    store.recordRun({
      taskId: "task_a",
      executionMode: "llm",
      status: "success",
      latencyMs: 50,
      timestamp: "2026-11-23T10:00:00.000Z",
    });
    fs.appendFileSync(historyPath, "{not-valid-json\n{\"bad\":true}\n", "utf-8");
    store.recordRun({
      taskId: "task_b",
      executionMode: "flow_trigger",
      status: "error",
      latencyMs: 150,
      timestamp: "2026-11-23T10:05:00.000Z",
      error: "timeout",
    });

    const runs = store.listRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.taskId)).toEqual(["task_a", "task_b"]);
  });
});

describe("ExecutionEngine automatic LocalHistoryStore recording", () => {
  let tmpDir: string;
  let historyPath: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routineweave-engine-history-"));
    historyPath = path.join(tmpDir, "runs.jsonl");
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records both successful and failed flow_trigger and openai_compat executions", async () => {
    const geminiMock = { generate: jest.fn() } as unknown as GeminiClient;
    const historyStore = new LocalHistoryStore(historyPath);

    const engine = new ExecutionEngine(geminiMock, new PromptRenderer(), {
      flowTriggerClient: new FlowTriggerClient({ defaultMaxRetries: 0, defaultRetryBaseDelayMs: 1 }),
      openAICompatClient: new OpenAICompatClient({ maxRetries: 0, retryBaseDelayMs: 1 }),
      historyStore,
    });

    // 1. Successful flow_trigger run
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 202,
      statusText: "Accepted",
      text: async () => JSON.stringify({ run_id: "r-101" }),
    } as Response);

    const flowTask = TaskDefinitionSchema.parse({
      task_name: "pi_backup_flow",
      schedule: "0 2 * * *",
      executionMode: "flow_trigger",
      max_retries: 0,
      flowTrigger: {
        endpointUrl: "http://127.0.0.1:8787/v1/triggers/webhook",
        flowId: "nightly_backup",
      },
      output: baseOutput,
    });
    const flowOk = await engine.execute(flowTask);
    expect(flowOk.success).toBe(true);

    // 2. Failed flow_trigger run
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "disk full",
    } as Response);
    const flowFail = await engine.execute(flowTask);
    expect(flowFail.success).toBe(false);

    // 3. Successful openai_compat run
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        model: "qwen2.5-3b-instruct",
        choices: [{ message: { content: "All clear." } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    } as Response);

    const llmTask = TaskDefinitionSchema.parse({
      task_name: "local_digest",
      schedule: "0 9 * * *",
      prompt: "Digest for {{topic}}",
      model: "qwen2.5-3b-instruct",
      provider: "openai_compat",
      max_retries: 0,
      providerConfig: {
        baseUrl: "http://127.0.0.1:8080",
      },
      input: { topic: "Robotics" },
      output: baseOutput,
    });
    const llmOk = await engine.execute(llmTask);
    expect(llmOk.success).toBe(true);

    // 4. Failed openai_compat run
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      text: async () => "model not loaded",
    } as Response);
    const llmFail = await engine.execute(llmTask);
    expect(llmFail.success).toBe(false);

    // Verify persisted history via a brand-new LocalHistoryStore instance
    const reopened = new LocalHistoryStore(historyPath);
    const runs = reopened.listRuns();
    expect(runs).toHaveLength(4);

    expect(runs[0]).toMatchObject({
      taskId: "pi_backup_flow",
      executionMode: "flow_trigger",
      status: "success",
      flowId: "nightly_backup",
    });
    expect(typeof runs[0].triggerId).toBe("string");
    expect(runs[0].triggerId?.length).toBeGreaterThan(0);

    expect(runs[1]).toMatchObject({
      taskId: "pi_backup_flow",
      executionMode: "flow_trigger",
      status: "error",
      flowId: "nightly_backup",
    });
    expect(runs[1].error).toContain("500: Internal Server Error");

    expect(runs[2]).toMatchObject({
      taskId: "local_digest",
      executionMode: "llm",
      status: "success",
      provider: "openai_compat",
      model: "qwen2.5-3b-instruct",
    });

    expect(runs[3]).toMatchObject({
      taskId: "local_digest",
      executionMode: "llm",
      status: "error",
      provider: "openai_compat",
      model: "qwen2.5-3b-instruct",
    });
    expect(runs[3].error).toContain("502: Bad Gateway");

    const stats = reopened.getStats();
    expect(stats.total).toBe(4);
    expect(stats.success).toBe(2);
    expect(stats.error).toBe(2);
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(geminiMock.generate).not.toHaveBeenCalled();
  });
});

describe("SchedulePreview (computeNextRuns & dryRunSchedule)", () => {
  it("computes accurate next runs for daily, step, range, and named cron expressions", () => {
    const from = new Date("2026-11-23T06:30:00.000Z"); // Monday

    // Daily at 07:00 UTC
    const daily = computeNextRuns("0 7 * * *", 3, from);
    expect(daily.map((d) => d.toISOString())).toEqual([
      "2026-11-23T07:00:00.000Z",
      "2026-11-24T07:00:00.000Z",
      "2026-11-25T07:00:00.000Z",
    ]);

    // Strictly after exact boundary
    const exactBoundary = computeNextRuns("0 7 * * *", 1, new Date("2026-11-23T07:00:00.000Z"));
    expect(exactBoundary[0].toISOString()).toBe("2026-11-24T07:00:00.000Z");

    // Every 15 minutes
    const every15 = computeNextRuns("*/15 * * * *", 4, new Date("2026-11-23T06:10:00.000Z"));
    expect(every15.map((d) => d.toISOString())).toEqual([
      "2026-11-23T06:15:00.000Z",
      "2026-11-23T06:30:00.000Z",
      "2026-11-23T06:45:00.000Z",
      "2026-11-23T07:00:00.000Z",
    ]);

    // Weekdays (MON-FRI) at 09:30 in Nov/Dec
    const weekdays = computeNextRuns("30 9 * NOV,DEC MON-FRI", 3, new Date("2026-11-27T09:00:00.000Z")); // Friday
    expect(weekdays.map((d) => d.toISOString())).toEqual([
      "2026-11-27T09:30:00.000Z", // Fri
      "2026-11-30T09:30:00.000Z", // Mon
      "2026-12-01T09:30:00.000Z", // Tue
    ]);

    // Sunday via 7
    const sundays = computeNextRuns("0 8 * * 7", 2, from);
    expect(sundays.map((d) => d.toISOString())).toEqual([
      "2026-11-29T08:00:00.000Z",
      "2026-12-06T08:00:00.000Z",
    ]);

    // Leap day fast-forward
    const leapDays = computeNextRuns("0 0 29 2 *", 2, from);
    expect(leapDays.map((d) => d.toISOString())).toEqual([
      "2028-02-29T00:00:00.000Z",
      "2032-02-29T00:00:00.000Z",
    ]);
  });

  it("rejects invalid cron expressions with InvalidCronExpressionError", () => {
    const invalidExprs = [
      "",
      "   ",
      "0 7 * *", // only 4 fields
      "0 0 7 * * *", // 6 fields
      "60 7 * * *", // minute out of range
      "0 24 * * *", // hour out of range
      "0 0 32 * *", // dom out of range
      "0 0 * 13 *", // month out of range
      "0 0 * * 8", // dow out of range
      "*/0 * * * *", // zero step
      "10-5 * * * *", // inverted range
      "invalid cron expr",
    ];

    for (const expr of invalidExprs) {
      expect(() => computeNextRuns(expr, 1, new Date("2026-11-23T00:00:00.000Z"))).toThrow(
        InvalidCronExpressionError,
      );
    }
  });

  it("dryRunSchedule returns chronological preview, skips disabled tasks, and collects warnings", () => {
    const from = new Date("2026-11-23T06:00:00.000Z");

    const tasks = [
      TaskDefinitionSchema.parse({
        task_name: "hourly_sensor_flow",
        schedule: "0 * * * *",
        executionMode: "flow_trigger",
        flowTrigger: {
          endpointUrl: "http://127.0.0.1:8787/v1/triggers/webhook",
          flowId: "sensor_sync",
        },
        output: baseOutput,
      }),
      TaskDefinitionSchema.parse({
        task_name: "half_hour_digest",
        schedule: "30 * * * *",
        prompt: "Summarize telemetry",
        output: baseOutput,
      }),
      TaskDefinitionSchema.parse({
        task_name: "disabled_task",
        schedule: "*/5 * * * *",
        prompt: "Disabled",
        enabled: false,
        output: baseOutput,
      }),
      {
        task_name: "broken_cron_task",
        schedule: "99 99 * * *",
        enabled: true,
        executionMode: "llm" as const,
      },
      {
        task_name: "impossible_date_task",
        schedule: "0 0 31 2 *",
        enabled: true,
        executionMode: "llm" as const,
      },
    ];

    const preview = dryRunSchedule(tasks, { fromDate: from, runsPerTask: 2 });

    expect(preview.skippedDisabled).toEqual(["disabled_task"]);
    expect(preview.warnings).toHaveLength(2);
    expect(preview.warnings.map((w) => w.taskName)).toEqual([
      "broken_cron_task",
      "impossible_date_task",
    ]);

    expect(preview.events).toHaveLength(4);
    expect(
      preview.events.map((e) => ({
        taskName: e.taskName,
        at: e.scheduledAtIso,
        mode: e.executionMode,
        flowId: e.flowId,
      })),
    ).toEqual([
      {
        taskName: "half_hour_digest",
        at: "2026-11-23T06:30:00.000Z",
        mode: "llm",
        flowId: undefined,
      },
      {
        taskName: "hourly_sensor_flow",
        at: "2026-11-23T07:00:00.000Z",
        mode: "flow_trigger",
        flowId: "sensor_sync",
      },
      {
        taskName: "half_hour_digest",
        at: "2026-11-23T07:30:00.000Z",
        mode: "llm",
        flowId: undefined,
      },
      {
        taskName: "hourly_sensor_flow",
        at: "2026-11-23T08:00:00.000Z",
        mode: "flow_trigger",
        flowId: "sensor_sync",
      },
    ]);

    // Respects maxTotalEvents and includeDisabled
    const capped = dryRunSchedule(tasks, {
      fromDate: from,
      runsPerTask: 2,
      includeDisabled: true,
      maxTotalEvents: 2,
    });
    expect(capped.skippedDisabled).toEqual([]);
    expect(capped.events).toHaveLength(2);
    expect(capped.events[0].taskName).toBe("disabled_task");
    expect(capped.events[0].scheduledAtIso).toBe("2026-11-23T06:05:00.000Z");
  });
});
