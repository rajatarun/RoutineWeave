import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { env } from "../config";
import { logger } from "../utils";

export interface SpanData {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  service: string;
  model?: string;
  toolName?: string;
  startTime: Date;
  endTime?: Date;
  inputHash?: string;
  outputHash?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd: number;
  statusCode?: number;
}

export class ObservatoryMetricsStore {
  private client: DynamoDBClient;

  constructor() {
    this.client = new DynamoDBClient({ region: env.AWS_REGION });
  }

  async persist(span: SpanData): Promise<void> {
    if (!env.OBSERVATORY_METRICS_TABLE) return;

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: env.OBSERVATORY_METRICS_TABLE,
          Item: {
            spanId: { S: span.spanId },
            traceId: { S: span.traceId },
            service: { S: span.service },
            startTime: { S: span.startTime.toISOString() },
            costUsd: { N: String(span.costUsd) },
            ...(span.parentSpanId ? { parentSpanId: { S: span.parentSpanId } } : {}),
            ...(span.model ? { model: { S: span.model } } : {}),
            ...(span.toolName ? { toolName: { S: span.toolName } } : {}),
            ...(span.endTime ? { endTime: { S: span.endTime.toISOString() } } : {}),
            ...(span.inputHash ? { inputHash: { S: span.inputHash } } : {}),
            ...(span.outputHash ? { outputHash: { S: span.outputHash } } : {}),
            ...(span.inputTokens != null ? { inputTokens: { N: String(span.inputTokens) } } : {}),
            ...(span.outputTokens != null ? { outputTokens: { N: String(span.outputTokens) } } : {}),
            ...(span.totalTokens != null ? { totalTokens: { N: String(span.totalTokens) } } : {}),
            ...(span.statusCode != null ? { statusCode: { N: String(span.statusCode) } } : {}),
          },
        })
      );
      logger.debug("Observatory span persisted", { spanId: span.spanId, service: span.service });
    } catch (error) {
      logger.warn("Failed to persist observatory span to DynamoDB", { error, spanId: span.spanId });
    }
  }
}

export const metricsStore = new ObservatoryMetricsStore();
