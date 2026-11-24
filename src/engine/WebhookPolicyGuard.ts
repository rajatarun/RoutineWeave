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

const UNSPECIFIED_HOSTS = new Set<string>(["0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);

const LOCALHOST_HOSTS = new Set<string>(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(host: string): string {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\.+$/, "");
}

/**
 * Extract the raw authority host from a URL string prior to WHATWG URL normalization,
 * so non-canonical numeric IPv4 encodings (decimal integer, hex, octal dotted-quad)
 * can be detected and rejected even when `new URL()` silently rewrites them.
 */
function extractRawHost(rawUrl: string): string | null {
  const match = rawUrl.trim().match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (!match) {
    return null;
  }
  let authority = match[1];
  const atIdx = authority.lastIndexOf("@");
  if (atIdx !== -1) {
    authority = authority.slice(atIdx + 1);
  }
  if (authority.startsWith("[")) {
    const closeIdx = authority.indexOf("]");
    return closeIdx !== -1 ? authority.slice(1, closeIdx).toLowerCase() : null;
  }
  const colonIdx = authority.indexOf(":");
  const host = colonIdx !== -1 ? authority.slice(0, colonIdx) : authority;
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Detect obfuscated/non-canonical numeric IPv4 host encodings:
 * - Pure decimal integer (e.g. `2852039166`)
 * - Hexadecimal integer (e.g. `0xa9fea9fe`)
 * - Dotted-quad with hex (`0x...`) or leading-zero octal octets (e.g. `0251.0376.0251.0376`)
 */
function isObfuscatedNumericIp(rawHost: string): boolean {
  if (!rawHost) {
    return false;
  }
  if (/^\d+$/.test(rawHost)) {
    return true;
  }
  if (/^0x[0-9a-f]+$/i.test(rawHost)) {
    return true;
  }
  const parts = rawHost.split(".");
  if (parts.length >= 2 && parts.length <= 4) {
    const allNumeric = parts.every((p) => /^(?:0x[0-9a-f]+|\d+)$/i.test(p));
    if (allNumeric) {
      if (parts.length !== 4) {
        return true;
      }
      const hasHexOrOctal = parts.some(
        (p) => /^0x/i.test(p) || (p.length > 1 && p.startsWith("0")),
      );
      if (hasHexOrOctal) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address if present.
 * Handles both dotted-quad (`::ffff:169.254.169.254`) and hex-pair (`::ffff:a9fe:a9fe`,
 * `0:0:0:0:0:ffff:a9fe:a9fe`) notations.
 */
function extractIpv4FromMappedIpv6(host: string): string | null {
  const lower = host.toLowerCase();

  // Dotted-quad form: ::ffff:a.b.c.d or 0:0:0:0:0:ffff:a.b.c.d
  const dottedMatch = lower.match(
    /^(?:::ffff:|(?:0+:){5}ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (dottedMatch) {
    return dottedMatch[1];
  }

  // Hex-pair form produced by WHATWG URL parser: ::ffff:a9fe:a9fe or ::ffff:7f00:1 or ::ffff:0:0
  const hexMatch = lower.match(
    /^(?:::ffff:|(?:0+:){5}ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }

  return null;
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

function isLoopbackIp(host: string): boolean {
  if (LOCALHOST_HOSTS.has(host)) {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  return false;
}

function isUnspecifiedIp(host: string): boolean {
  if (UNSPECIFIED_HOSTS.has(host)) {
    return true;
  }
  if (/^0\.0\.0\.0$/.test(host)) {
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
 * - Blocks obfuscated numeric IPv4 encodings (decimal integer, hex, octal dotted-quad).
 * - Blocks unspecified addresses (`0.0.0.0`, `::`, `::ffff:0.0.0.0`), cloud metadata endpoints,
 *   link-local ranges, and IPv4-mapped IPv6 SSRF bypass vectors.
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

    const rawHost = extractRawHost(url);
    if (rawHost !== null && isObfuscatedNumericIp(rawHost)) {
      return {
        allowed: false,
        reason: `Obfuscated numeric IP host "${rawHost}" is blocked by SSRF policy`,
      };
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

    const mappedIpv4 = extractIpv4FromMappedIpv6(normalizedHost);
    const hostsToCheck = mappedIpv4 ? [normalizedHost, mappedIpv4] : [normalizedHost];
    const hostWithPort = parsed.port ? `${normalizedHost}:${parsed.port}` : normalizedHost;

    for (const candidate of hostsToCheck) {
      if (isUnspecifiedIp(candidate)) {
        return {
          allowed: false,
          reason: `Unspecified address "${normalizedHost}" is blocked by SSRF policy`,
        };
      }
      if (DEFAULT_BLOCKED_METADATA_HOSTS.has(candidate) || isLinkLocalIp(candidate)) {
        return {
          allowed: false,
          reason: `Host "${normalizedHost}" is blocked as a cloud metadata or link-local address`,
        };
      }
    }

    for (const blocked of this.blockedHosts) {
      if (
        hostsToCheck.some((candidate) => {
          const candidateWithPort = parsed.port ? `${candidate}:${parsed.port}` : candidate;
          return matchesHostPattern(candidate, candidateWithPort, blocked);
        })
      ) {
        return {
          allowed: false,
          reason: `Host "${normalizedHost}" is explicitly blocked by policy`,
        };
      }
    }

    if (protocol === "http:") {
      const isLocal = hostsToCheck.some((candidate) => isLoopbackIp(candidate));
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
