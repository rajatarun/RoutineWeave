import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { env } from "./environment";
import { logger } from "../utils/logger";

const GEMINI_SECRET_ID = "gemini/api_key";

const client = new SecretsManagerClient({ region: env.AWS_REGION });
let cachedApiKey: string | undefined;

export async function getGeminiApiKey(): Promise<string> {
  // Local dev: GEMINI_API_KEY in env takes precedence over Secrets Manager
  if (env.GEMINI_API_KEY) return env.GEMINI_API_KEY;

  if (cachedApiKey) return cachedApiKey;

  logger.info("Fetching Gemini API key from Secrets Manager", { secretId: GEMINI_SECRET_ID });

  const response = await client.send(
    new GetSecretValueCommand({ SecretId: GEMINI_SECRET_ID }),
  );

  const raw = response.SecretString;
  if (!raw) throw new Error(`Secret "${GEMINI_SECRET_ID}" has no SecretString value`);

  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("key" in parsed) || typeof (parsed as Record<string, unknown>).key !== "string") {
    throw new Error(`Secret "${GEMINI_SECRET_ID}" must be a JSON object with a "key" field`);
  }

  cachedApiKey = (parsed as { key: string }).key;
  return cachedApiKey;
}
