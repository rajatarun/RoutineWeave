import { GoogleGenAI, Tool, GenerateContentConfig } from "@google/genai";
import { getGeminiApiKey } from "../config";
import { withRetry } from "../utils";
import { env } from "../config";
import { createObservedGeminiRequest } from "../observability";

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

  private async getAI(): Promise<GoogleGenAI> {
    if (!this.ai) {
      const apiKey = await getGeminiApiKey();
      this.ai = new GoogleGenAI({ apiKey });
    }
    return this.ai;
  }

  async generate(request: GeminiRequest): Promise<GeminiResponse> {
    const observer = createObservedGeminiRequest(request.model, request.prompt);

    return withRetry(
      async () => {
        try {
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

          const result: GeminiResponse = {
            text,
            model: request.model,
            promptTokens: response.usageMetadata?.promptTokenCount,
            outputTokens: response.usageMetadata?.candidatesTokenCount,
            groundingUsed: request.grounding ?? false,
          };

          await observer.recordSuccess(result.promptTokens, result.outputTokens);
          return result;
        } catch (error) {
          if (error instanceof Error) {
            await observer.recordError(error);
          }
          throw error;
        }
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
    );
  }
}
