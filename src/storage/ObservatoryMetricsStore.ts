import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { env } from "../config";
import { logger } from "../utils";

export interface SpanData {
  spanId: string;
  traceId: string;
  service: string;
  model?: string;
  startTime: Date;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
}

export interface DecisionData {
  action: string;
  reason?: string;
}

const TTL_SECONDS = 7_776_000; // 90 days

export class ObservatoryMetricsStore {
  private client: DynamoDBClient;

  constructor() {
    this.client = new DynamoDBClient({ region: env.AWS_REGION });
  }

  async persist(span: SpanData, decision: DecisionData): Promise<void> {
    if (!env.OBSERVATORY_METRICS_TABLE) return;

    const operation = "invoke_model";
    const pk = `OBSERVATORY#${operation}`;
    const sk = `${span.startTime.toISOString()}#${span.spanId}`;
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: env.OBSERVATORY_METRICS_TABLE,
          Item: {
            pk: { S: pk },
            sk: { S: sk },
            trace_id: { S: span.spanId },
            operation: { S: operation },
            timestamp: { S: span.startTime.toISOString() },
            prompt_tokens: { N: String(span.inputTokens ?? 0) },
            completion_tokens: { N: String(span.outputTokens ?? 0) },
            cost_usd: { N: span.costUsd.toFixed(8) },
            decision: { S: decision.action },
            decision_reason: { S: decision.reason ?? "none" },
            ttl: { N: String(ttl) },
            ...(span.service ? { service: { S: span.service } } : {}),
            ...(span.model ? { model: { S: span.model } } : {}),
          },
        })
      );
      logger.debug("Observatory span persisted", { pk, sk });
    } catch (error) {
      logger.warn("Failed to persist observatory span to DynamoDB", { error, spanId: span.spanId });
    }
  }
}

export const metricsStore = new ObservatoryMetricsStore();
