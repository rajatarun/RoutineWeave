import { GoogleGenAI, Tool, GenerateContentConfig } from "@google/genai";
import { getGeminiApiKey } from "../config";
import { withRetry } from "../utils";
import { env } from "../config";
import type { SpanData } from "../storage/ObservatoryMetricsStore";
import { metricsStore } from "../storage/ObservatoryMetricsStore";

interface McpWrapper {
  invoke(params: {
    source: string;
    model: string;
    prompt: string;
    call: () => Promise<unknown>;
  }): Promise<{ output: unknown; span: { toJSON(): SpanData } }>;
}

// new Function prevents TypeScript from transpiling import() to require(),
// allowing Node.js to load the ESM-only package via native dynamic import.
const esmImport = new Function("m", "return import(m)") as (
  m: string,
) => Promise<{ InvocationWrapper: new (name: string) => McpWrapper }>;

export interface GeminiRequest {
  model: string;
  prompt: string;
  grounding?: boolean;
  generationConfig?: Omit<GenerateContentConfig, "tools">;
}

export interface GeminiResponse {
  text: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  groundingUsed: boolean;
}

const GROUNDING_TOOL: Tool = { googleSearch: {} };

export class GeminiClient {
  private ai: GoogleGenAI | null = null;
  private wrapper: McpWrapper | null = null;

  private async getWrapper(): Promise<McpWrapper> {
    if (!this.wrapper) {
      const { InvocationWrapper } = await esmImport("@weaveaijs/mcp-observatory");
      this.wrapper = new InvocationWrapper("routineweave-gemini");
    }
    return this.wrapper;
  }

  private async getAI(): Promise<GoogleGenAI> {
    if (!this.ai) {
      const apiKey = await getGeminiApiKey();
      this.ai = new GoogleGenAI({ apiKey });
    }
    return this.ai;
  }

  async generate(request: GeminiRequest): Promise<GeminiResponse> {
    const wrapper = await this.getWrapper();
    const result = await wrapper.invoke({
      source: "model",
      model: request.model,
      prompt: request.prompt,
      call: () =>
        withRetry(
          async () => {
            const ai = await this.getAI();
            const tools: Tool[] = request.grounding ? [GROUNDING_TOOL] : [];

            const config: GenerateContentConfig = {
              ...request.generationConfig,
              ...(tools.length > 0 ? { tools } : {}),
            };

            const response = await ai.models.generateContent({
              model: request.model,
              contents: request.prompt,
              config,
            });

            const text = response.text;

            if (!text) {
              throw new Error("Gemini returned empty response");
            }

            return {
              text,
              model: request.model,
              promptTokens: response.usageMetadata?.promptTokenCount,
              outputTokens: response.usageMetadata?.candidatesTokenCount,
              groundingUsed: request.grounding ?? false,
            };
          },
          {
            maxAttempts: env.MAX_RETRIES,
            baseDelayMs: env.RETRY_BASE_DELAY_MS,
            shouldRetry: (error) => {
              if (error instanceof Error) {
                const msg = error.message.toLowerCase();
                if (msg.includes("api key") || msg.includes("quota") || msg.includes("invalid argument")) {
                  return false;
                }
              }
              return true;
            },
          },
          `GeminiClient.generate(${request.model})`,
        ),
    });

    await metricsStore.persist(result.span.toJSON());
    return result.output as GeminiResponse;
  }
}
