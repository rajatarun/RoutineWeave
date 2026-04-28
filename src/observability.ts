import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { env } from "./config";
import { logger } from "./utils";

const dynamoClient = new DynamoDBClient({ region: env.AWS_REGION });

interface ModelRequestMetrics {
  timestamp: number;
  model: string;
  provider: "gemini" | "bedrock";
  promptTokens?: number;
  outputTokens?: number;
  duration: number;
  status: "success" | "error";
  errorMessage?: string;
}

const getTTL = (): number => {
  // 30 days in seconds
  return Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
};

const generateMetricId = (timestamp: number, model: string, index: number): string => {
  return `${timestamp}-${model}-${index}`;
};

export async function observeModelRequest(
  model: string,
  provider: "gemini" | "bedrock",
  metrics: Omit<ModelRequestMetrics, "timestamp" | "model" | "provider">
): Promise<void> {
  if (!env.OBSERVATORY_METRICS_TABLE) {
    logger.debug("Observatory metrics table not configured, skipping metrics");
    return;
  }

  try {
    const timestamp = Date.now();
    const pk = provider.toUpperCase();
    const sk = generateMetricId(timestamp, model, Math.floor(Math.random() * 1000));

    const item = {
      pk,
      sk,
      timestamp,
      model,
      provider,
      ...metrics,
      ttl: getTTL(),
    };

    await dynamoClient.send(
      new PutItemCommand({
        TableName: env.OBSERVATORY_METRICS_TABLE,
        Item: marshall(item),
      })
    );

    logger.debug("Model request metrics recorded", {
      model,
      provider,
      duration: metrics.duration,
      status: metrics.status,
    });
  } catch (error) {
    // Silently fail on metrics errors - observability must not break production
    logger.warn("Failed to record model metrics", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createObservedGeminiRequest(model: string, prompt: string) {
  const startTime = Date.now();
  return {
    startObservation: () => startTime,
    recordSuccess: (promptTokens?: number, outputTokens?: number) => {
      const duration = Date.now() - startTime;
      return observeModelRequest(model, "gemini", {
        promptTokens,
        outputTokens,
        duration,
        status: "success",
      });
    },
    recordError: (error: Error) => {
      const duration = Date.now() - startTime;
      return observeModelRequest(model, "gemini", {
        duration,
        status: "error",
        errorMessage: error.message,
      });
    },
  };
}

export function createObservedBedrockRequest(model: string) {
  const startTime = Date.now();
  return {
    startObservation: () => startTime,
    recordSuccess: (outputTokens?: number) => {
      const duration = Date.now() - startTime;
      return observeModelRequest(model, "bedrock", {
        outputTokens,
        duration,
        status: "success",
      });
    },
    recordError: (error: Error) => {
      const duration = Date.now() - startTime;
      return observeModelRequest(model, "bedrock", {
        duration,
        status: "error",
        errorMessage: error.message,
      });
    },
  };
}
