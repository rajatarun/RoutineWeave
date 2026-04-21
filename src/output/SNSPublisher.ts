import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { OutputHandler, OutputPayload } from "./interfaces";
import { withRetry } from "../utils";
import { env } from "../config";
import { logger } from "../utils";

export class SNSPublisher implements OutputHandler {
  readonly name = "sns";
  private client: SNSClient;

  constructor() {
    this.client = new SNSClient({ region: env.AWS_REGION });
  }

  async publish(payload: OutputPayload, config: Record<string, unknown>): Promise<void> {
    const topicArn = (config["sns_topic_arn"] as string | undefined) ?? env.SNS_TOPIC_ARN;

    const subject = payload.success
      ? `[RoutineWeave] ${payload.task} — Completed`
      : `[RoutineWeave] ${payload.task} — FAILED`;

    const messageBody = this.formatMessage(payload);

    await withRetry(
      async () => {
        const command = new PublishCommand({
          TopicArn: topicArn,
          Subject: subject,
          Message: messageBody,
          MessageAttributes: {
            task_name: { DataType: "String", StringValue: payload.task },
            success: { DataType: "String", StringValue: String(payload.success) },
          },
        });

        const response = await this.client.send(command);
        logger.info(`SNS message published`, { messageId: response.MessageId, task: payload.task });
      },
      { maxAttempts: env.MAX_RETRIES, baseDelayMs: env.RETRY_BASE_DELAY_MS },
      `SNSPublisher.publish(${payload.task})`,
    );
  }

  private formatMessage(payload: OutputPayload): string {
    const lines = [
      `Task: ${payload.task}`,
      `Timestamp: ${payload.timestamp}`,
      `Status: ${payload.success ? "SUCCESS" : "FAILED"}`,
      `Duration: ${payload.duration_ms}ms`,
      "",
      "--- Result ---",
      payload.result,
    ];

    if (payload.error) {
      lines.push("", "--- Error ---", payload.error);
    }

    return lines.join("\n");
  }
}
