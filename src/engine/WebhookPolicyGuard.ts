export interface WebhookPolicyGuardOptions {
  allowedHosts?: string[];
  allowLocalhostHttp?: boolean;
  blockedHosts?: string[];
}

export interface WebhookPolicyDecision {
  allowed: boolean;
  reason?: string;
}

export class WebhookPolicyError extends Error {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`Webhook URL blocked by policy (${url}): ${reason}`);
    this.name = "WebhookPolicyError";
    this.url = url;
    this.reason = reason;
  }
}

const DEFAULT_BLOCKED_METADATA_HOSTS = new Set<string>([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200",
  "fd00:ec2::254",
]);

const LOCALHOST_HOSTS = new Set<string>(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, "");
}

function isLinkLocalIp(host: string): boolean {
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  if (/^fe[89ab][0-9a-f]:/i.test(host)) {
    return true;
  }
  return false;
}

function matchesHostPattern(host: string, hostWithPort: string, pattern: string): boolean {
  const normalizedPattern = normalizeHost(pattern);
  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1); // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  return host === normalizedPattern || hostWithPort === normalizedPattern;
}

/**
 * Outbound webhook URL policy guard enforcing SSRF and transport-security rules:
 * - Only allows `https:` and `http:` schemes.
 * - Blocks cloud metadata endpoints (`169.254.169.254`, link-local ranges, etc.) and custom `blockedHosts`.
 * - Blocks plain `http:` to non-localhost hosts (and optionally to localhost when `allowLocalhostHttp` is false).
 * - Enforces an optional `allowedHosts` allowlist when configured.
 */
export class WebhookPolicyGuard {
  private readonly allowedHosts?: string[];
  private readonly allowLocalhostHttp: boolean;
  private readonly blockedHosts: string[];

  constructor(options: WebhookPolicyGuardOptions = {}) {
    this.allowedHosts = options.allowedHosts
      ? options.allowedHosts.map((h) => h.trim()).filter((h) => h.length > 0)
      : undefined;
    this.allowLocalhostHttp = options.allowLocalhostHttp ?? true;
    this.blockedHosts = (options.blockedHosts ?? [])
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
  }

  validateUrl(url: string): WebhookPolicyDecision {
    if (!url || typeof url !== "string" || !url.trim()) {
      return { allowed: false, reason: "Webhook URL must be a non-empty string" };
    }

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return { allowed: false, reason: "Invalid webhook URL format" };
    }

    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "http:") {
      return {
        allowed: false,
        reason: `Disallowed URL scheme "${protocol}"; only http: and https: are permitted`,
      };
    }

    const normalizedHost = normalizeHost(parsed.hostname);
    if (!normalizedHost) {
      return { allowed: false, reason: "Webhook URL must include a valid hostname" };
    }

    const hostWithPort = parsed.port ? `${normalizedHost}:${parsed.port}` : normalizedHost;

    if (DEFAULT_BLOCKED_METADATA_HOSTS.has(normalizedHost) || isLinkLocalIp(normalizedHost)) {
      return {
        allowed: false,
        reason: `Host "${normalizedHost}" is blocked as a cloud metadata or link-local address`,
      };
    }

    for (const blocked of this.blockedHosts) {
      if (matchesHostPattern(normalizedHost, hostWithPort, blocked)) {
        return {
          allowed: false,
          reason: `Host "${normalizedHost}" is explicitly blocked by policy`,
        };
      }
    }

    if (protocol === "http:") {
      const isLocal = LOCALHOST_HOSTS.has(normalizedHost);
      if (!isLocal) {
        return {
          allowed: false,
          reason: `Plain HTTP is not allowed for non-localhost host "${normalizedHost}"`,
        };
      }
      if (!this.allowLocalhostHttp) {
        return {
          allowed: false,
          reason: `Plain HTTP is disabled for localhost host "${normalizedHost}"`,
        };
      }
    }

    if (this.allowedHosts !== undefined) {
      const permitted = this.allowedHosts.some((pattern) =>
        matchesHostPattern(normalizedHost, hostWithPort, pattern),
      );
      if (!permitted) {
        return {
          allowed: false,
          reason: `Host "${normalizedHost}" is not in allowedHosts`,
        };
      }
    }

    return { allowed: true };
  }
}
