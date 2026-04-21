import { GoogleGenAI, Tool, GenerateContentConfig } from "@google/genai";
import { withRetry } from "../utils";
import { env } from "../config";

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
  private ai: GoogleGenAI;

  constructor(apiKey: string = env.GEMINI_API_KEY) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(request: GeminiRequest): Promise<GeminiResponse> {
    return withRetry(
      async () => {
        const tools: Tool[] = request.grounding ? [GROUNDING_TOOL] : [];

        const config: GenerateContentConfig = {
          ...request.generationConfig,
          ...(tools.length > 0 ? { tools } : {}),
        };

        const response = await this.ai.models.generateContent({
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
    );
  }
}
