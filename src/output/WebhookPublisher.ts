import { OutputHandler, OutputPayload } from "./interfaces";
import { withRetry } from "../utils";
import { env } from "../config";
import { logger } from "../utils";

/**
 * A model told to return "JSON only" still fences it often enough to matter,
 * and search grounding makes it likelier. Fenced text parses as nothing, so
 * without this the payload below degrades to `{ result: "```json\n{...}" }` and
 * the real fields never reach the receiver. NovaStructurer strips the fence on
 * the save path; this is the same treatment on the delivery path.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-z]*[ \t]*\r?\n?/i, "")
    .replace(/\r?\n?```$/, "")
    .trim();
}

export class WebhookPublisher implements OutputHandler {
  readonly name = "webhook";

  async publish(payload: OutputPayload, config: Record<string, unknown>): Promise<void> {
    const url = config["url"] as string | undefined;

    if (!url) {
      throw new Error("Webhook URL is missing in the output configuration.");
    }

    const customHeaders = (config["headers"] as Record<string, string> | undefined) ?? {};

    const headers = {
      "Content-Type": "application/json",
      ...customHeaders,
    };

    let requestPayload: unknown;
    try {
      requestPayload = JSON.parse(stripCodeFence(payload.result));
    } catch {
      // The fallback keeps the delivery alive, but it changes the shape of the
      // request: a receiver that requires named fields answers 4xx, and the run
      // has already been recorded as a success. Say so in the log rather than
      // leaving the mismatch to be inferred from the receiver's side.
      logger.warn(`Task ${payload.task} output is not JSON; posting it as { result }`, {
        url,
        preview: payload.result.slice(0, 200),
      });
      requestPayload = { result: payload.result };
    }

    // Header names only. A webhook target that needs an API key or a bearer
    // token carries it here, and CloudWatch is not the place to keep it.
    logger.info(`Webhook request payload for task ${payload.task}`, {
      url,
      headerNames: Object.keys(headers).sort(),
      payload: requestPayload,
    });

    await withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(requestPayload),
          });
        } catch (error: any) {
          if (error instanceof Error && error.cause) {
            const causeStr = error.cause instanceof Error ? error.cause.message : String(error.cause);
            throw new Error(`fetch failed: ${causeStr}`);
          }
          throw error;
        }

        if (!response.ok) {
          throw new Error(`Webhook responded with status ${response.status}: ${response.statusText}`);
        }

        logger.info(`Webhook published successfully`, { url, task: payload.task });
      },
      { maxAttempts: env.MAX_RETRIES, baseDelayMs: env.RETRY_BASE_DELAY_MS },
      `WebhookPublisher.publish(${payload.task})`,
    );
  }
}
