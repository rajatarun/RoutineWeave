import { logger } from "./logger";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  operationName: string,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs = 30_000, shouldRetry = () => true } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !shouldRetry(error)) {
        logger.error(`${operationName} failed after ${attempt} attempt(s)`, {
          error: error instanceof Error ? error.message : String(error),
          attempt,
        });
        throw error;
      }

      const jitter = Math.random() * 200;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1) + jitter, maxDelayMs);

      logger.warn(`${operationName} attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`, {
        error: error instanceof Error ? error.message : String(error),
        nextAttempt: attempt + 1,
        maxAttempts,
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
