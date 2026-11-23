import crypto from "crypto";
import { FlowTriggerConfig } from "../scheduler/types";
import { logger, withRetry } from "../utils";

export interface WeaveTriggerV1Payload {
  schema: "weave-trigger-v1";
  trigger_id: string;
  task_id: string;
  flow_id: string;
  fired_at: string;
  inputs: Record<string, unknown>;
}

export interface FlowTriggerRequest {
  taskId: string;
  config: FlowTriggerConfig;
  triggerId?: string;
  firedAt?: string;
  extraInputs?: Record<string, unknown>;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface FlowTriggerResponse {
  status: number;
  triggerId: string;
  flowId: string;
  body: string;
  json?: Record<string, unknown>;
}

export class FlowTriggerHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, statusText: string, bodySnippet?: string) {
    const suffix = bodySnippet ? ` - ${bodySnippet}` : "";
    super(`Flow trigger endpoint responded with status ${status}: ${statusText}${suffix}`);
    this.name = "FlowTriggerHttpError";
    this.status = status;
    this.retryable = status >= 500 || status === 408 || status === 429;
  }
}

export interface FlowTriggerClientOptions {
  defaultTimeoutMs?: number;
  defaultMaxRetries?: number;
  defaultRetryBaseDelayMs?: number;
}

export class FlowTriggerClient {
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRetries: number;
  private readonly defaultRetryBaseDelayMs: number;

  constructor(options: FlowTriggerClientOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.defaultMaxRetries = options.defaultMaxRetries ?? 2;
    this.defaultRetryBaseDelayMs = options.defaultRetryBaseDelayMs ?? 1000;
  }

  async dispatch(request: FlowTriggerRequest): Promise<FlowTriggerResponse> {
    const { config, taskId } = request;
    const triggerId = request.triggerId ?? crypto.randomUUID();
    const firedAt = request.firedAt ?? new Date().toISOString();
    const timeoutMs = config.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = request.maxRetries ?? this.defaultMaxRetries;
    const baseDelayMs = request.retryBaseDelayMs ?? this.defaultRetryBaseDelayMs;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.authTokenEnv) {
      const token = process.env[config.authTokenEnv];
      if (!token) {
        throw new Error(
          `Environment variable "${config.authTokenEnv}" is not set for flowTrigger auth token`,
        );
      }
      headers["Authorization"] = `Bearer ${token}`;
    }

    const inputs: Record<string, unknown> = {
      ...(request.extraInputs ?? {}),
      ...(config.inputs ?? {}),
    };

    const payload: WeaveTriggerV1Payload = {
      schema: "weave-trigger-v1",
      trigger_id: triggerId,
      task_id: taskId,
      flow_id: config.flowId,
      fired_at: firedAt,
      inputs,
    };

    logger.info("Dispatching weave-trigger-v1 flow trigger", {
      taskId,
      flowId: config.flowId,
      triggerId,
      endpointUrl: config.endpointUrl,
      hasAuth: Boolean(config.authTokenEnv),
    });

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(config.endpointUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          const body = typeof response.text === "function" ? await response.text() : "";

          if (!response.ok) {
            const snippet = body.trim().slice(0, 200);
            throw new FlowTriggerHttpError(response.status, response.statusText, snippet || undefined);
          }

          let json: Record<string, unknown> | undefined;
          if (body.trim()) {
            try {
              const parsed: unknown = JSON.parse(body);
              if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                json = parsed as Record<string, unknown>;
              }
            } catch {
              // Plain-text response body is valid; leave json undefined.
            }
          }

          return {
            status: response.status,
            triggerId,
            flowId: config.flowId,
            body,
            json,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxAttempts: Math.max(1, maxRetries + 1),
        baseDelayMs,
        shouldRetry: (error) => {
          if (error instanceof FlowTriggerHttpError) {
            return error.retryable;
          }
          return true;
        },
      },
      `FlowTriggerClient.dispatch(${taskId} -> ${config.flowId})`,
    );
  }
}
