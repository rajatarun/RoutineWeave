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

// A single input value: plain string or a list that gets JSON.stringify'd into the prompt
export const InputValueSchema = z.union([z.string(), z.array(z.string())]);
export type InputValue = z.infer<typeof InputValueSchema>;

export const TaskDefinitionSchema = z.object({
  task_name: z.string().min(1).regex(/^[a-z0-9_]+$/, "task_name must be lowercase alphanumeric with underscores"),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().default("gemini-3.1-flash-lite-preview"),
  grounding: z.boolean().default(false),
  variables: z.record(z.string()).optional(),
  // input values can be strings or arrays; arrays are JSON.stringify'd before injection
  input: z.record(InputValueSchema).optional(),
  output: OutputConfigSchema,
  enabled: z.boolean().default(true),
  save_result: z.boolean().default(false),
  timeout_ms: z.number().int().min(1000).max(300_000).default(60_000),
  max_retries: z.number().int().min(0).max(10).optional(),
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
