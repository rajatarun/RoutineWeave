import { withRetry } from "../utils/retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const op = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(op, { maxAttempts: 3, baseDelayMs: 10 }, "test");
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and succeeds", async () => {
    const op = jest.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("ok");
    const result = await withRetry(op, { maxAttempts: 3, baseDelayMs: 10 }, "test");
    expect(result).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all attempts", async () => {
    const op = jest.fn().mockRejectedValue(new Error("always fails"));
    await expect(withRetry(op, { maxAttempts: 3, baseDelayMs: 10 }, "test")).rejects.toThrow("always fails");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("does not retry when shouldRetry returns false", async () => {
    const op = jest.fn().mockRejectedValue(new Error("quota exceeded"));
    await expect(
      withRetry(
        op,
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          shouldRetry: (e) => !(e instanceof Error && e.message.includes("quota")),
        },
        "test",
      ),
    ).rejects.toThrow("quota exceeded");
    expect(op).toHaveBeenCalledTimes(1);
  });
});
