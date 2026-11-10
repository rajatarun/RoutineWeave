process.env.SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:test-topic";

import { SlackPublisher } from "../output/SlackPublisher";
import { buildPayload } from "../output/interfaces";
import type { TaskExecutionResult } from "../scheduler/types";

const mockFetch = jest.fn();

beforeAll(() => {
  global.fetch = mockFetch as unknown as typeof fetch;
});

const makeResult = (overrides: Partial<TaskExecutionResult> = {}): TaskExecutionResult => ({
  task_name: "test_task",
  timestamp: "2024-01-01T00:00:00.000Z",
  success: true,
  result: "Hello from RoutineWeave",
  duration_ms: 120,
  ...overrides,
});

describe("SlackPublisher", () => {
  const publisher = new SlackPublisher();

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
  });

  it("posts a Block Kit payload to the webhook URL", async () => {
    const payload = buildPayload(makeResult());
    await publisher.publish(payload, { webhook_url: "https://hooks.slack.com/services/T/B/X" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/services/T/B/X");
    const body = JSON.parse(init.body as string) as { blocks: unknown[]; channel?: string };
    expect(body.blocks).toHaveLength(3);
    expect(body.channel).toBeUndefined();
  });

  it("includes optional channel override", async () => {
    const payload = buildPayload(makeResult());
    await publisher.publish(payload, {
      webhook_url: "https://hooks.slack.com/services/T/B/X",
      channel: "#alerts",
    });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string) as {
      channel: string;
    };
    expect(body.channel).toBe("#alerts");
  });

  it("throws when webhook_url is missing", async () => {
    const payload = buildPayload(makeResult());
    await expect(publisher.publish(payload, {})).rejects.toThrow("webhook_url is missing");
  });
});
