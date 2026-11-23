import { logger, withRetry } from "../utils";

export interface OpenAICompatClientOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface OpenAICompatRequest {
  model: string;
  prompt: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface OpenAICompatResponse {
  text: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  groundingUsed: false;
}

interface ChatCompletionJson {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAICompatHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, statusText: string, bodySnippet?: string) {
    const suffix = bodySnippet ? ` - ${bodySnippet}` : "";
    super(`OpenAI-compatible endpoint responded with status ${status}: ${statusText}${suffix}`);
    this.name = "OpenAICompatHttpError";
    this.status = status;
    this.retryable = status >= 500 || status === 408 || status === 429;
  }
}

export class OpenAICompatClient {
  private readonly defaultBaseUrl?: string;
  private readonly defaultApiKey?: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRetries: number;
  private readonly defaultRetryBaseDelayMs: number;

  constructor(options: OpenAICompatClientOptions = {}) {
    this.defaultBaseUrl = options.baseUrl;
    this.defaultApiKey = options.apiKey;
    this.defaultTimeoutMs = options.timeoutMs ?? 290_000;
    this.defaultMaxRetries = options.maxRetries ?? 2;
    this.defaultRetryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  private resolveEndpoint(requestBaseUrl?: string): string {
    const raw =
      requestBaseUrl ??
      this.defaultBaseUrl ??
      process.env.OPENAI_COMPAT_BASE_URL ??
      "http://127.0.0.1:8080";
    const normalized = raw.replace(/\/+$/, "");
    return normalized.endsWith("/v1")
      ? `${normalized}/chat/completions`
      : `${normalized}/v1/chat/completions`;
  }

  private resolveApiKey(apiKeyEnv?: string): string | undefined {
    if (apiKeyEnv) {
      const token = process.env[apiKeyEnv];
      if (!token) {
        throw new Error(
          `Environment variable "${apiKeyEnv}" is not set for openai_compat API key`,
        );
      }
      return token;
    }
    return this.defaultApiKey ?? process.env.OPENAI_COMPAT_API_KEY;
  }

  async generate(request: OpenAICompatRequest): Promise<OpenAICompatResponse> {
    const endpoint = this.resolveEndpoint(request.baseUrl);
    const apiKey = this.resolveApiKey(request.apiKeyEnv);
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = request.maxRetries ?? this.defaultMaxRetries;
    const baseDelayMs = request.retryBaseDelayMs ?? this.defaultRetryBaseDelayMs;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    const payload: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: false,
    };
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      payload.max_tokens = request.maxTokens;
    }

    logger.debug("Calling OpenAI-compatible chat completions endpoint", {
      endpoint,
      model: request.model,
      hasAuth: Boolean(apiKey),
    });

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          if (!response.ok) {
            const errBody = typeof response.text === "function" ? await response.text() : "";
            const snippet = errBody.trim().slice(0, 200);
            throw new OpenAICompatHttpError(
              response.status,
              response.statusText,
              snippet || undefined,
            );
          }

          const data = (await response.json()) as ChatCompletionJson;
          const content = data.choices?.[0]?.message?.content;

          if (!content) {
            throw new Error("OpenAI-compatible endpoint returned empty response");
          }

          return {
            text: content,
            model: data.model ?? request.model,
            promptTokens: data.usage?.prompt_tokens,
            outputTokens: data.usage?.completion_tokens,
            groundingUsed: false,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxAttempts: Math.max(1, maxRetries + 1),
        baseDelayMs,
        shouldRetry: (error) => {
          if (error instanceof OpenAICompatHttpError) {
            return error.retryable;
          }
          if (error instanceof Error && error.message.includes("returned empty response")) {
            return false;
          }
          return true;
        },
      },
      `OpenAICompatClient.generate(${request.model})`,
    );
  }
}
