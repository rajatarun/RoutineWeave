process.env.SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:test-topic";

import { WebhookPublisher } from "../output/WebhookPublisher";
import { OutputPayload } from "../output/interfaces";

const makePayload = (overrides: Partial<OutputPayload> = {}): OutputPayload => ({
  task: "test_task",
  timestamp: "2024-01-01T00:00:00.000Z",
  success: true,
  result: "Test output",
  duration_ms: 500,
  ...overrides,
});

describe("WebhookPublisher", () => {
  let publisher: WebhookPublisher;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    publisher = new WebhookPublisher();
    fetchSpy = jest.spyOn(global, "fetch");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("throws error if URL is not provided", async () => {
    const payload = makePayload();
    await expect(publisher.publish(payload, {})).rejects.toThrow(
      "Webhook URL is missing in the output configuration."
    );
  });

  it("publishes to webhook with default headers, wrapping non-JSON string in result object", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const payload = makePayload({ result: "Test output" });
    await publisher.publish(payload, { url: "https://example.com/hook" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/hook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ result: "Test output" }),
    });
  });

  it("publishes to webhook with custom headers, parsing JSON result", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const payload = makePayload({
      result: JSON.stringify({ key: "value", nested: { prop: 123 } }),
    });
    await publisher.publish(payload, {
      url: "https://example.com/hook",
      headers: {
        Authorization: "Bearer token123",
        "X-Custom-Header": "value123",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/hook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token123",
        "X-Custom-Header": "value123",
      },
      body: JSON.stringify({ key: "value", nested: { prop: 123 } }),
    });
  });

  it("retries on fetch error due to withRetry wrapper", async () => {
    // We will test that it throws when fetch is not ok
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    const payload = makePayload();

    await expect(
      publisher.publish(payload, { url: "https://example.com/hook" })
    ).rejects.toThrow("Webhook responded with status 500: Internal Server Error");
  });
});
