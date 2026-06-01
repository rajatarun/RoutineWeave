import { OutputHandler, OutputPayload } from "./interfaces";
import { withRetry } from "../utils";
import { env } from "../config";
import { logger } from "../utils";

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
      requestPayload = JSON.parse(payload.result);
    } catch {
      requestPayload = { result: payload.result };
    }

    logger.info(`Webhook request payload for task ${payload.task}`, { url, headers, payload: requestPayload });

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
