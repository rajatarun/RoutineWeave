import { OutputRouter } from "../output/OutputRouter";
import { OutputHandler, OutputPayload } from "../output/interfaces";
import { TaskExecutionResult } from "../scheduler/types";

const mockSNSPublish = jest.fn().mockResolvedValue(undefined);

jest.mock("../output/SNSPublisher", () => ({
  SNSPublisher: jest.fn().mockImplementation(() => ({
    name: "sns",
    publish: mockSNSPublish,
  })),
}));

const makeResult = (overrides: Partial<TaskExecutionResult> = {}): TaskExecutionResult => ({
  task_name: "test_task",
  timestamp: "2024-01-01T00:00:00.000Z",
  success: true,
  result: "Test output",
  duration_ms: 500,
  ...overrides,
});

describe("OutputRouter", () => {
  let router: OutputRouter;

  beforeEach(() => {
    jest.clearAllMocks();
    router = new OutputRouter();
  });

  it("routes to SNS handler", async () => {
    const result = makeResult();
    await router.route(result, {
      type: "sns",
      sns_topic_arn: "arn:aws:sns:us-east-1:123:test",
    });
    expect(mockSNSPublish).toHaveBeenCalledTimes(1);
    const [payload] = mockSNSPublish.mock.calls[0] as [OutputPayload];
    expect(payload.task).toBe("test_task");
    expect(payload.success).toBe(true);
  });

  it("allows registering custom handlers", async () => {
    const customHandler: OutputHandler = {
      name: "webhook",
      publish: jest.fn().mockResolvedValue(undefined),
    };
    router.registerHandler(customHandler);

    const result = makeResult();
    await router.route(result, {
      type: "webhook",
      url: "https://example.com/hook",
    });
    expect(customHandler.publish).toHaveBeenCalledTimes(1);
  });

  it("throws for unsupported output type", async () => {
    const result = makeResult();
    await expect(
      router.route(result, { type: "slack", webhook_url: "https://example.com" }),
    ).rejects.toThrow("Unsupported output type: slack");
  });
});
