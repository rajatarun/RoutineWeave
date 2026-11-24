import crypto from "crypto";
import { WebhookPolicyError, WebhookPolicyGuard } from "./WebhookPolicyGuard";

export interface RoutineDefinition {
  id?: string;
  task_name?: string;
  name?: string;
  schedule: string;
  enabled?: boolean;
  webhookUrl?: string;
  endpointUrl?: string;
  hmacSecret?: string;
  authToken?: string;
  apiKey?: string;
  output?: {
    type?: string;
    url?: string;
    webhook_url?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  flowTrigger?: {
    endpointUrl?: string;
    flowId?: string;
    authToken?: string;
    authTokenEnv?: string;
    hmacSecret?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RoutineBundle {
  schema: "routine-bundle-v1";
  bundle_id: string;
  node_id: string;
  created_at: string;
  routines: RoutineDefinition[];
  checksum_sha256: string;
}

export interface ExportRoutineBundleOptions {
  nodeId?: string;
}

const SECRET_FIELD_KEYS = new Set<string>([
  "hmacsecret",
  "hmac_secret",
  "authtoken",
  "auth_token",
  "apikey",
  "api_key",
  "authorization",
  "x-api-key",
  "clientsecret",
  "client_secret",
  "password",
  "secret",
]);

const URL_FIELD_KEYS = new Set<string>([
  "webhookurl",
  "webhook_url",
  "endpointurl",
  "endpoint_url",
  "url",
]);

function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretFields(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_KEYS.has(k.trim().toLowerCase())) {
        continue;
      }
      out[k] = stripSecretFields(v);
    }
    return out;
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function computeRoutinesChecksum(routines: RoutineDefinition[]): string {
  const canonicalJson = JSON.stringify(canonicalize(routines));
  return crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

function collectWebhookUrls(value: unknown, urls: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWebhookUrls(item, urls);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (URL_FIELD_KEYS.has(k.trim().toLowerCase()) && typeof v === "string" && v.trim()) {
        urls.push(v.trim());
      } else if (v !== null && typeof v === "object") {
        collectWebhookUrls(v, urls);
      }
    }
  }
}

/**
 * Serialize routines into a portable, integrity-verified `RoutineBundle`.
 * Strips secret fields (`hmacSecret`, `authToken`, `apiKey`, Authorization headers, etc.)
 * so exported bundles are safe to store or migrate across edge devices.
 */
export function exportRoutineBundle(
  routines: RoutineDefinition[],
  options: ExportRoutineBundleOptions = {},
): RoutineBundle {
  if (!Array.isArray(routines)) {
    throw new TypeError("routines must be an array");
  }

  const sanitizedRoutines = routines.map(
    (routine) => stripSecretFields(routine) as RoutineDefinition,
  );
  const checksum = computeRoutinesChecksum(sanitizedRoutines);
  const nodeId = (options.nodeId ?? "local-node").trim() || "local-node";

  return {
    schema: "routine-bundle-v1",
    bundle_id: `rb-${crypto.randomUUID()}`,
    node_id: nodeId,
    created_at: new Date().toISOString(),
    routines: sanitizedRoutines,
    checksum_sha256: checksum,
  };
}

/**
 * Verify a portable `RoutineBundle` checksum fail-closed and validate all embedded
 * webhook/endpoint URLs through `WebhookPolicyGuard` before returning cloned routines.
 */
export function importRoutineBundle(
  bundle: RoutineBundle,
  policyGuard?: WebhookPolicyGuard,
): RoutineDefinition[] {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("Invalid routine bundle: expected object");
  }
  if (!Array.isArray(bundle.routines)) {
    throw new Error("Invalid routine bundle: routines must be an array");
  }
  if (
    typeof bundle.checksum_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(bundle.checksum_sha256)
  ) {
    throw new Error("Invalid routine bundle: missing or malformed checksum_sha256");
  }

  const expected = computeRoutinesChecksum(bundle.routines);
  const providedBuf = Buffer.from(bundle.checksum_sha256.toLowerCase(), "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new Error(
      `Routine bundle checksum mismatch: expected ${expected}, got ${bundle.checksum_sha256}`,
    );
  }

  const guard = policyGuard ?? new WebhookPolicyGuard();
  for (const routine of bundle.routines) {
    const urls: string[] = [];
    collectWebhookUrls(routine, urls);
    for (const url of urls) {
      const decision = guard.validateUrl(url);
      if (!decision.allowed) {
        throw new WebhookPolicyError(url, decision.reason ?? "Blocked by webhook policy");
      }
    }
  }

  return JSON.parse(JSON.stringify(bundle.routines)) as RoutineDefinition[];
}
