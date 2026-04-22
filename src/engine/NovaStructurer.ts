import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { env } from "../config/environment";
import { logger } from "../utils";

const MODEL_ID = "us.amazon.nova-2-lite-v1:0";

const SYSTEM_PROMPT = `You are a JSON structuring assistant. Your only job is to convert raw AI task output text into a well-structured JSON object.

RULES:
- Output ONLY a valid JSON object. No markdown, no code fences, no explanation, no preamble.
- Do NOT ask questions. Do NOT request clarification.
- Use best effort to infer the most meaningful structure from the content.
- Preserve all information — do not omit or summarise away any data.
- Always include these top-level fields:
    "summary"  : one-sentence summary of the entire output (string)
    "data"     : the main structured content extracted from the text (object or array)
    "raw_text" : the original unmodified text verbatim (string)`;

export interface StructuredResult {
  summary: string;
  data: unknown;
  raw_text: string;
  [key: string]: unknown;
}

export class NovaStructurer {
  private client: BedrockRuntimeClient;

  constructor() {
    this.client = new BedrockRuntimeClient({ region: env.AWS_REGION });
  }

  async structure(text: string): Promise<StructuredResult> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [
          {
            role: "user",
            content: [{ text: `Convert the following task output to structured JSON:\n\n${text}` }],
          },
        ],
        inferenceConfig: { maxTokens: 4096, temperature: 0 },
      })
    );

    const raw = response.output?.message?.content?.[0]?.text ?? "";

    // Strip any accidental markdown code fences before parsing
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let parsed: StructuredResult;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      logger.warn("Nova returned non-JSON; wrapping in fallback structure", { preview: cleaned.slice(0, 200) });
      parsed = { summary: "Failed to parse structured output", data: {}, raw_text: text };
    }

    // Guarantee required fields exist
    if (!parsed.raw_text) parsed.raw_text = text;
    if (!parsed.summary) parsed.summary = "";
    if (!Object.prototype.hasOwnProperty.call(parsed, "data")) parsed.data = {};

    logger.info("Nova structuring complete", { model: MODEL_ID, summary: parsed.summary });
    return parsed;
  }
}
