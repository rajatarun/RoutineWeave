process.env.SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:test-topic";

import { WebhookPublisher, stripCodeFence } from "../output/WebhookPublisher";
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

describe("stripCodeFence", () => {
  it("leaves unfenced text alone", () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });

  it("removes a ```json fence", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("removes a bare ``` fence", () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("removes a fence around multi-line JSON without touching its interior", () => {
    expect(stripCodeFence('```json\n{\n  "a": 1\n}\n```')).toBe('{\n  "a": 1\n}');
  });

  it("keeps a fence that appears inside the text rather than around it", () => {
    // Only a fence the whole payload is wrapped in is a wrapper; one in the
    // middle is content, and cutting it would corrupt the string.
    const text = 'prose\n```js\ncode\n```\nmore prose';
    expect(stripCodeFence(text)).toBe(text);
  });
});

describe("WebhookPublisher JSON handling", () => {
  let publisher: WebhookPublisher;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    publisher = new WebhookPublisher();
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("posts the fields of a fenced JSON result, not the fence", async () => {
    // Before this was handled, the body became { result: "```json…" } — which
    // a receiver requiring a `title` rejects, after the run was already logged
    // as a success.
    const article = { title: "A headline", topic: "t", objective: "o", sourceInputs: "s" };
    await publisher.publish(
      makePayload({ result: "```json\n" + JSON.stringify(article) + "\n```" }),
      { url: "https://example.com/hook" },
    );

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual(article);
  });

  it("still wraps genuinely non-JSON output", async () => {
    await publisher.publish(makePayload({ result: "not json at all" }), {
      url: "https://example.com/hook",
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ result: "not json at all" });
  });

  it("does not put header values in the log", async () => {
    // The logger writes to process.stdout directly, so that is what has to be
    // observed — a console.log spy sees nothing and passes either way.
    const written: string[] = [];
    const stdoutSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

    await publisher.publish(makePayload({ result: '{"ok":true}' }), {
      url: "https://example.com/hook",
      headers: { "x-api-key": "sk-super-secret-value" },
    });
    stdoutSpy.mockRestore();

    expect(written.join("")).toContain("x-api-key");
    expect(written.join("")).not.toContain("sk-super-secret-value");
  });
});
