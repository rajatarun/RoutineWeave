import { z } from "zod";

export const SNSOutputSchema = z.object({
  type: z.literal("sns"),
  sns_topic_arn: z.string().optional(),
});

export const SlackOutputSchema = z.object({
  type: z.literal("slack"),
  webhook_url: z.string().url(),
  channel: z.string().optional(),
});

export const WebhookOutputSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const OutputConfigSchema = z.discriminatedUnion("type", [
  SNSOutputSchema,
  SlackOutputSchema,
  WebhookOutputSchema,
]);

export const ExecutionModeSchema = z.enum(["llm", "flow_trigger"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const FlowTriggerConfigSchema = z.object({
  endpointUrl: z.string().url(),
  flowId: z.string().min(1),
  authTokenEnv: z.string().min(1).optional(),
  inputs: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});
export type FlowTriggerConfig = z.infer<typeof FlowTriggerConfigSchema>;

export const ProviderSchema = z.enum(["gemini", "openai_compat"]);
export type LLMProvider = z.infer<typeof ProviderSchema>;

export const OpenAICompatConfigSchema = z.object({
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional(),
});
export type OpenAICompatConfig = z.infer<typeof OpenAICompatConfigSchema>;

// A single input value: plain string or a list that gets JSON.stringify'd into the prompt
export const InputValueSchema = z.union([z.string(), z.array(z.string())]);
export type InputValue = z.infer<typeof InputValueSchema>;

export const TaskDefinitionSchema = z
  .object({
    task_name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9_]+$/, "task_name must be lowercase alphanumeric with underscores"),
    schedule: z.string().min(1),
    prompt: z.string().default(""),
    model: z.string().default("gemini-3.5-flash-lite"),
    grounding: z.boolean().default(false),
    variables: z.record(z.string()).optional(),
    // input values can be strings or arrays; arrays are JSON.stringify'd before injection
    input: z.record(InputValueSchema).optional(),
    output: OutputConfigSchema,
    enabled: z.boolean().default(true),
    save_result: z.boolean().default(false),
    timeout_ms: z.number().int().min(1000).max(300_000).default(290_000),
    max_retries: z.number().int().min(0).max(10).optional(),
    executionMode: ExecutionModeSchema.optional(),
    flowTrigger: FlowTriggerConfigSchema.optional(),
    provider: ProviderSchema.optional(),
    providerConfig: OpenAICompatConfigSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const mode = data.executionMode ?? "llm";
    if (mode === "llm" && data.prompt.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "prompt is required when executionMode is llm",
      });
    }
    if (mode === "flow_trigger" && !data.flowTrigger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flowTrigger"],
        message: "flowTrigger is required when executionMode is flow_trigger",
      });
    }
  });

export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type SNSOutput = z.infer<typeof SNSOutputSchema>;

export interface TaskExecutionResult {
  task_name: string;
  timestamp: string;
  success: boolean;
  result?: string;
  structured_result?: Record<string, unknown>;
  error?: string;
  duration_ms: number;
}
