import { S3TaskStore } from "../storage/S3TaskStore";

const validTask = {
  task_name: "test_task",
  schedule: "0 * * * *",
  prompt: "Test prompt",
  model: "gemini-3.1-flash-lite-preview",
  grounding: false,
  enabled: true,
  timeout_ms: 60000,
  output: { type: "sns" as const, sns_topic_arn: "arn:aws:sns:us-east-1:123:test" },
};

const mockSend = jest.fn();

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

// Suppress env validation error for missing TASKS_BUCKET
jest.mock("../config", () => ({
  env: {
    AWS_REGION: "us-east-1",
    TASKS_BUCKET: "test-bucket",
    TASKS_S3_PREFIX: "tasks/",
    MAX_RETRIES: 3,
    RETRY_BASE_DELAY_MS: 100,
  },
}));

describe("S3TaskStore", () => {
  let store: S3TaskStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new S3TaskStore("test-bucket", "tasks/");
  });

  it("get returns null for missing task (NoSuchKey)", async () => {
    const { NoSuchKey } = await import("@aws-sdk/client-s3");
    mockSend.mockRejectedValue(new NoSuchKey({ message: "Not Found", $metadata: {} }));
    const result = await store.get("missing_task");
    expect(result).toBeNull();
  });

  it("get returns parsed task for existing key", async () => {
    mockSend.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify(validTask) },
    });
    const task = await store.get("test_task");
    expect(task).not.toBeNull();
    expect(task?.task_name).toBe("test_task");
  });

  it("get returns null for invalid task JSON in S3", async () => {
    mockSend.mockResolvedValue({
      Body: { transformToString: async () => JSON.stringify({ bad: "data" }) },
    });
    const task = await store.get("test_task");
    expect(task).toBeNull();
  });

  it("put serializes and sends task to correct key", async () => {
    mockSend.mockResolvedValue({});
    await store.put(validTask);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0];
    expect(command.input.Key).toBe("tasks/test_task.json");
    expect(command.input.ContentType).toBe("application/json");
  });

  it("delete returns false when task does not exist", async () => {
    const { NoSuchKey } = await import("@aws-sdk/client-s3");
    mockSend.mockRejectedValue(new NoSuchKey({ message: "Not Found", $metadata: {} }));
    const deleted = await store.delete("ghost_task");
    expect(deleted).toBe(false);
  });

  it("delete returns true and sends DeleteObjectCommand for existing task", async () => {
    mockSend
      .mockResolvedValueOnce({
        Body: { transformToString: async () => JSON.stringify(validTask) },
      })
      .mockResolvedValueOnce({});
    const deleted = await store.delete("test_task");
    expect(deleted).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("uses provided bucket and prefix over env defaults", () => {
    const store = new S3TaskStore("explicit-bucket", "custom/");
    expect(store).toBeDefined();
  });
});
