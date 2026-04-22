import { z } from "zod";

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  SNS_TOPIC_ARN: z.string().min(1, "SNS_TOPIC_ARN is required"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TASKS_DIR: z.string().default("./tasks"),
  TASKS_BUCKET: z.string().optional(),
  TASKS_S3_PREFIX: z.string().default("tasks/"),
  RESULTS_BUCKET: z.string().optional(),
  SCHEDULER_LAMBDA_ARN: z.string().optional(),
  MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  RETRY_BASE_DELAY_MS: z.coerce.number().int().min(100).default(1000),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `  ${e.path.join(".")}: ${e.message}`).join("\n");
    throw new Error(`Environment configuration invalid:\n${errors}`);
  }
  return result.data;
}

export const env = loadEnv();
