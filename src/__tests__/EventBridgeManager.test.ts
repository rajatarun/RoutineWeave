const mockSend = jest.fn();

jest.mock("@aws-sdk/client-eventbridge", () => {
  const actual = jest.requireActual("@aws-sdk/client-eventbridge");
  return {
    ...actual,
    EventBridgeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

jest.mock("../config", () => ({
  env: {
    AWS_REGION: "us-east-1",
    SCHEDULER_LAMBDA_ARN: "arn:aws:lambda:us-east-1:123:function:routineweave-scheduler",
    NODE_ENV: "test",
  },
}));

import { EventBridgeManager } from "../events/EventBridgeManager";

const validTask = {
  task_name: "test_task",
  schedule: "0 */6 * * *",
  prompt: "Test",
  model: "gemini-3.1-flash-lite-preview",
  grounding: false,
  enabled: true,
  timeout_ms: 60000,
  output: { type: "sns" as const, sns_topic_arn: "arn:aws:sns:us-east-1:123:test" },
};

describe("EventBridgeManager.toEventBridgeCron", () => {
  let manager: EventBridgeManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new EventBridgeManager();
  });

  it("converts every-6-hours cron (both dom/dow *)", () => {
    expect(manager.toEventBridgeCron("0 */6 * * *")).toBe("cron(0 */6 * * ? *)");
  });

  it("converts daily cron", () => {
    expect(manager.toEventBridgeCron("0 8 * * *")).toBe("cron(0 8 * * ? *)");
  });

  it("converts weekly cron (dow specified → dom becomes ?)", () => {
    expect(manager.toEventBridgeCron("0 9 * * 1")).toBe("cron(0 9 ? * 1 *)");
  });

  it("converts monthly cron (dom specified → dow becomes ?)", () => {
    expect(manager.toEventBridgeCron("0 0 1 * *")).toBe("cron(0 0 1 * ? *)");
  });

  it("throws for non-5-field expression", () => {
    expect(() => manager.toEventBridgeCron("* * * *")).toThrow("5-field");
  });
});

describe("EventBridgeManager.upsertRule", () => {
  let manager: EventBridgeManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
    manager = new EventBridgeManager();
  });

  it("calls PutRule then PutTargets", async () => {
    await manager.upsertRule(validTask);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const [putRule, putTargets] = mockSend.mock.calls;
    expect(putRule[0].input.Name).toBe("routineweave-task-test_task");
    expect(putRule[0].input.ScheduleExpression).toBe("cron(0 */6 * * ? *)");
    expect(putRule[0].input.State).toBe("ENABLED");
    expect(putTargets[0].input.Targets[0].Id).toBe("SchedulerLambda");
    expect(JSON.parse(putTargets[0].input.Targets[0].Input).detail.task_name).toBe("test_task");
  });

  it("sets rule to DISABLED when task.enabled is false", async () => {
    await manager.upsertRule({ ...validTask, enabled: false });
    const [putRule] = mockSend.mock.calls;
    expect(putRule[0].input.State).toBe("DISABLED");
  });
});

describe("EventBridgeManager.deleteRule", () => {
  let manager: EventBridgeManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new EventBridgeManager();
  });

  it("calls RemoveTargets then DeleteRule", async () => {
    mockSend.mockResolvedValue({});
    await manager.deleteRule("test_task");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("does not throw when rule does not exist (ResourceNotFoundException)", async () => {
    const { ResourceNotFoundException } = await import("@aws-sdk/client-eventbridge");
    mockSend.mockRejectedValue(
      new ResourceNotFoundException({ message: "Rule not found", $metadata: {} }),
    );
    await expect(manager.deleteRule("ghost_task")).resolves.toBeUndefined();
  });
});
