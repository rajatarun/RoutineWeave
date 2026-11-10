import { OutputHandler, OutputPayload } from "./interfaces";
import { withRetry } from "../utils";
import { env } from "../config";
import { logger } from "../utils";
import { stripCodeFence } from "./WebhookPublisher";

/**
 * Delivers task results to a Slack Incoming Webhook URL.
 * See https://api.slack.com/messaging/webhooks
 */
export class SlackPublisher implements OutputHandler {
  readonly name = "slack";

  async publish(payload: OutputPayload, config: Record<string, unknown>): Promise<void> {
    const webhookUrl = config["webhook_url"] as string | undefined;

    if (!webhookUrl) {
      throw new Error("Slack webhook_url is missing in the output configuration.");
    }

    const channel = config["channel"] as string | undefined;
    const statusEmoji = payload.success ? ":white_check_mark:" : ":x:";
    const header = `${statusEmoji} *RoutineWeave — ${payload.task}*`;

    let bodyText = payload.result;
    try {
      const parsed = JSON.parse(stripCodeFence(payload.result)) as unknown;
      if (parsed && typeof parsed === "object") {
        bodyText = "```\n" + JSON.stringify(parsed, null, 2) + "\n```";
      }
    } catch {
      // Keep plain text for non-JSON model output
    }

    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: header },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: bodyText.slice(0, 2900) },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Duration: ${payload.duration_ms}ms · ${payload.timestamp}`,
          },
        ],
      },
    ];

    const slackPayload: Record<string, unknown> = { blocks };
    if (channel) {
      slackPayload.channel = channel;
    }

    await withRetry(
      async () => {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slackPayload),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `Slack webhook responded with status ${response.status}: ${text.slice(0, 200)}`,
          );
        }

        logger.info("Slack message published", { task: payload.task });
      },
      { maxAttempts: env.MAX_RETRIES, baseDelayMs: env.RETRY_BASE_DELAY_MS },
      `SlackPublisher.publish(${payload.task})`,
    );
  }
}
