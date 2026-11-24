import {
  FlowTriggerClient,
  FlowTriggerHttpError,
  FlowTriggerRequest,
} from "../engine/FlowTriggerClient";
import { WebhookPolicyError } from "../engine/WebhookPolicyGuard";
import { FlowTriggerConfig } from "../scheduler/types";
import { logger } from "../utils";
import { DeadLetterEntry, LocalDeadLetterStore } from "./LocalDeadLetterStore";

export interface DeadLetterReplayerOptions {
  maxAttempts?: number;
  backoffMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface ReplayPendingOptions {
  taskId?: string;
  limit?: number;
}

export interface DeadLetterReplayResult {
  id: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

export interface DeadLetterReplaySummary {
  attempted: number;
  succeeded: number;
  failed: number;
  results: DeadLetterReplayResult[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildFlowTriggerRequest(entry: DeadLetterEntry): FlowTriggerRequest | null {
  if (!isPlainObject(entry.payload)) {
    return null;
  }

  const payload = entry.payload;
  const nestedConfig = isPlainObject(payload.config) ? payload.config : undefined;

  const endpointUrl =
    typeof payload.endpointUrl === "string"
      ? payload.endpointUrl
      : typeof nestedConfig?.endpointUrl === "string"
        ? nestedConfig.endpointUrl
        : undefined;

  const flowId =
    typeof payload.flowId === "string"
      ? payload.flowId
      : typeof nestedConfig?.flowId === "string"
        ? nestedConfig.flowId
        : entry.flowId;

  if (!endpointUrl || !flowId) {
    return null;
  }

  const rawInputs = isPlainObject(payload.inputs)
    ? payload.inputs
    : isPlainObject(nestedConfig?.inputs)
      ? nestedConfig.inputs
      : undefined;

  const authTokenEnv =
    typeof payload.authTokenEnv === "string"
      ? payload.authTokenEnv
      : typeof nestedConfig?.authTokenEnv === "string"
        ? nestedConfig.authTokenEnv
        : undefined;

  const timeoutMs =
    typeof payload.timeoutMs === "number"
      ? payload.timeoutMs
      : typeof nestedConfig?.timeoutMs === "number"
        ? nestedConfig.timeoutMs
        : undefined;

  const config: FlowTriggerConfig = {
    endpointUrl,
    flowId,
    ...(rawInputs !== undefined ? { inputs: rawInputs } : {}),
    ...(authTokenEnv !== undefined ? { authTokenEnv } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };

  const extraInputs = isPlainObject(payload.extraInputs) ? payload.extraInputs : undefined;
  const triggerId = typeof payload.triggerId === "string" ? payload.triggerId : undefined;

  return {
    taskId: entry.taskId,
    config,
    ...(extraInputs !== undefined ? { extraInputs } : {}),
    ...(triggerId !== undefined ? { triggerId } : {}),
    // Replayer owns retry/backoff semantics so each loop iteration is one dispatch attempt.
    maxRetries: 0,
  };
}

/**
 * Replays un-replayed entries from a `LocalDeadLetterStore` through a `FlowTriggerClient`
 * with exponential backoff retries, marking succeeded entries as replayed.
 */
export class DeadLetterReplayer {
  private readonly deadLetterStore: LocalDeadLetterStore;
  private readonly triggerClient: FlowTriggerClient;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    deadLetterStore: LocalDeadLetterStore,
    triggerClient: FlowTriggerClient,
    options: DeadLetterReplayerOptions = {},
  ) {
    this.deadLetterStore = deadLetterStore;
    this.triggerClient = triggerClient;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.backoffMs = Math.max(0, options.backoffMs ?? 100);
    this.sleepFn = options.sleepFn ?? defaultSleep;
  }

  async replayPending(options: ReplayPendingOptions = {}): Promise<DeadLetterReplaySummary> {
    let entries = this.deadLetterStore.list({
      taskId: options.taskId,
      includeReplayed: false,
    });

    if (options.limit !== undefined) {
      const limit = Math.max(0, Math.floor(options.limit));
      entries = entries.slice(0, limit);
    }

    const results: DeadLetterReplayResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (const entry of entries) {
      const request = buildFlowTriggerRequest(entry);
      if (!request) {
        const error = `Dead-letter entry "${entry.id}" does not contain a replayable flow trigger payload`;
        logger.warn(error, { entryId: entry.id, taskId: entry.taskId });
        failed += 1;
        results.push({ id: entry.id, ok: false, attempts: 1, error });
        continue;
      }

      let attempts = 0;
      let ok = false;
      let lastError: string | undefined;

      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        attempts = attempt;
        try {
          await this.triggerClient.dispatch(request);
          ok = true;
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);

          const nonRetryable =
            err instanceof WebhookPolicyError ||
            (err instanceof FlowTriggerHttpError && !err.retryable);

          if (nonRetryable || attempt >= this.maxAttempts) {
            break;
          }

          const delayMs = this.backoffMs * Math.pow(2, attempt - 1);
          await this.sleepFn(delayMs);
        }
      }

      if (ok) {
        this.deadLetterStore.markReplayed(entry.id);
        succeeded += 1;
        results.push({ id: entry.id, ok: true, attempts });
      } else {
        failed += 1;
        results.push({
          id: entry.id,
          ok: false,
          attempts,
          error: lastError ?? "Unknown replay error",
        });
      }
    }

    return {
      attempted: results.length,
      succeeded,
      failed,
      results,
    };
  }
}
