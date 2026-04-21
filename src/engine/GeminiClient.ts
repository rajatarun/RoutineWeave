import { GoogleGenerativeAI, GenerativeModel, GenerationConfig } from "@google/generative-ai";
import { withRetry } from "../utils";
import { env } from "../config";

export interface GeminiRequest {
  model: string;
  prompt: string;
  timeoutMs?: number;
  generationConfig?: GenerationConfig;
}

export interface GeminiResponse {
  text: string;
  model: string;
  promptTokens?: number;
  outputTokens?: number;
}

export class GeminiClient {
  private genAI: GoogleGenerativeAI;
  private modelCache = new Map<string, GenerativeModel>();

  constructor(apiKey: string = env.GEMINI_API_KEY) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  private getModel(modelName: string): GenerativeModel {
    if (!this.modelCache.has(modelName)) {
      this.modelCache.set(modelName, this.genAI.getGenerativeModel({ model: modelName }));
    }
    return this.modelCache.get(modelName)!;
  }

  async generate(request: GeminiRequest): Promise<GeminiResponse> {
    const model = this.getModel(request.model);

    return withRetry(
      async () => {
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: request.prompt }] }],
          generationConfig: request.generationConfig ?? {
            temperature: 0.7,
            maxOutputTokens: 2048,
          },
        });

        const response = result.response;
        const text = response.text();

        if (!text) {
          throw new Error("Gemini returned empty response");
        }

        return {
          text,
          model: request.model,
          promptTokens: response.usageMetadata?.promptTokenCount,
          outputTokens: response.usageMetadata?.candidatesTokenCount,
        };
      },
      {
        maxAttempts: env.MAX_RETRIES,
        baseDelayMs: env.RETRY_BASE_DELAY_MS,
        shouldRetry: (error) => {
          if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            // Do not retry on auth or quota errors
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
