import { lookup } from 'node:dns/promises';
import {
  normalizePort,
  isAddressInAllowedSet,
  normalizeAllowedAddressesSet,
} from './allowedAddresses';
import { isPrivateIP } from './ip';

/** Re-exported here for backward compatibility; canonical location is `./ip`. */
export { isPrivateIP };

/** The failure message login strategies report when the email-domain policy rejects a login. */
export const EMAIL_DOMAIN_NOT_ALLOWED = 'Email domain not allowed';

/**
 * @param email
 * @param allowedDomains
 */
export function isEmailDomainAllowed(email: string, allowedDomains?: string[] | null): boolean {
  /** If no domain restrictions are configured, allow all */
  if (!allowedDomains || !Array.isArray(allowedDomains) || !allowedDomains.length) {
    return true;
  }

  /** If restrictions exist, validate email format */
  if (!email) {
    return false;
  }

  const domain = email.split('@')[1]?.toLowerCase();

  if (!domain) {
    return false;
  }

  return allowedDomains.some((allowedDomain) => allowedDomain?.toLowerCase() === domain);
}

/**
 * Checks whether a hostname/IP literal and port appear in an admin-supplied
 * exemption list. Address match is case-insensitive and bracket-stripped, so
 * `[::1]` matches `::1` and `LOCALHOST` matches `localhost` when the port
 * also matches.
 *
 * The normalization and scoping rules live in `./allowedAddresses` so the
 * connect-time DNS lookup in `agent.ts` and this preflight helper share a
 * single implementation. See that module for the security invariants.
 */
export function isAddressAllowed(
  hostnameOrIP: string,
  allowedAddresses?: string[] | null,
  port?: string | number | null,
): boolean {
  const set = normalizeAllowedAddressesSet(allowedAddresses);
  return isAddressInAllowedSet(hostnameOrIP, set, port);
}

/**
 * Checks if a hostname resolves to a private/reserved IP address.
 * Directly validates literal IPv4 and IPv6 addresses without DNS lookup.
 * For hostnames, resolves via DNS and checks all returned addresses.
 * Fails open on DNS errors (returns false), since the HTTP request would also fail.
 *
 * When `allowedAddresses` is provided, the hostname/port and any resolved
 * IP/port are matched against the list — a match short-circuits to `false`
 * so admin-exempted private services bypass the SSRF block.
 */
export async function resolveHostnameSSRF(
  hostname: string,
  allowedAddresses?: string[] | null,
  port?: string | number | null,
): Promise<boolean> {
  const normalizedHost = hostname.toLowerCase().trim();

  if (isAddressAllowed(normalizedHost, allowedAddresses, port)) {
    return false;
  }

  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(normalizedHost)) {
    return isPrivateIP(normalizedHost);
  }

  const ipv6Check = normalizedHost.replace(/^\[|\]$/g, '');
  if (ipv6Check.includes(':')) {
    return isPrivateIP(ipv6Check);
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.some(
      (entry) =>
        isPrivateIP(entry.address) && !isAddressAllowed(entry.address, allowedAddresses, port),
    );
  } catch {
    return false;
  }
}

/**
 * SSRF Protection: Checks if a hostname/IP is a potentially dangerous internal target.
 * Blocks private IPs, localhost, cloud metadata IPs, and common internal hostnames.
 *
 * When `allowedAddresses` is provided, a literal host:port match exempts the
 * target — used by admins to permit known-good internal services (self-hosted
 * Ollama, Docker host, etc.) without disabling SSRF protection for every port
 * on the same host.
 *
 * @param hostname - The hostname or IP to check
 * @param allowedAddresses - Optional admin exemption list of host:port pairs
 * @returns true if the target is blocked (SSRF risk), false if safe
 */
export function isSSRFTarget(
  hostname: string,
  allowedAddresses?: string[] | null,
  port?: string | number | null,
): boolean {
  const normalizedHost = hostname.toLowerCase().trim();

  if (isAddressAllowed(normalizedHost, allowedAddresses, port)) {
    return false;
  }

  if (
    normalizedHost === 'localhost' ||
    normalizedHost === 'localhost.localdomain' ||
    normalizedHost.endsWith('.localhost')
  ) {
    return true;
  }

  if (isPrivateIP(normalizedHost)) {
    return true;
  }

  // Block common internal Docker/Kubernetes service names
  const internalHostnames = [
    'rag_api',
    'rag-api',
    'api',
    'redis',
    'mongodb',
    'mongo',
    'postgres',
    'postgresql',
    'mysql',
    'database',
    'db',
    'elasticsearch',
    'kibana',
    'grafana',
    'prometheus',
    'rabbitmq',
    'kafka',
    'zookeeper',
    'consul',
    'vault',
    'etcd',
    'minio',
    'internal',
    'backend',
    'metadata', // Common metadata service name
  ];

  if (internalHostnames.includes(normalizedHost)) {
    return true;
  }

  // Block .internal and .local TLDs (common in internal networks)
  if (normalizedHost.endsWith('.internal') || normalizedHost.endsWith('.local')) {
    return true;
  }

  return false;
}

/** Supported protocols for domain validation (HTTP, HTTPS, WebSocket) */
type SupportedProtocol = 'http:' | 'https:' | 'ws:' | 'wss:';

/**
 * Parsed domain specification including protocol and port constraints.
 */
interface ParsedDomainSpec {
  hostname: string;
  protocol: SupportedProtocol | null; // null means any protocol allowed
  port: string | null; // null means any port allowed
  explicitPort: boolean; // true if port was explicitly specified in original string
  isWildcard: boolean;
}

/** Checks if a string starts with a recognized protocol prefix */
function hasRecognizedProtocol(domain: string): boolean {
  return (
    domain.startsWith('http://') ||
    domain.startsWith('https://') ||
    domain.startsWith('ws://') ||
    domain.startsWith('wss://')
  );
}

/**
 * Parses a domain specification into its components.
 * Supports formats:
 *   - `example.com` (any protocol, any port)
 *   - `https://example.com` (https only, any port)
 *   - `https://example.com:443` (https only, port 443)
 *   - `wss://ws.example.com` (secure WebSocket only)
 *   - `*.example.com` (wildcard subdomain)
 * @param domain - Domain specification string
 * @returns ParsedDomainSpec or null if invalid
 */
function parseDomainSpec(domain: string): ParsedDomainSpec | null {
  try {
    let normalizedDomain = domain.toLowerCase().trim();

    // Early return for obviously invalid formats (protocol-only strings)
    const emptyProtocols = ['http://', 'https://', 'ws://', 'wss://'];
    if (emptyProtocols.includes(normalizedDomain)) {
      return null;
    }

    // Check for wildcard prefix before parsing
    const isWildcard = normalizedDomain.startsWith('*.');

    // Check if it has a recognized protocol (http, https, ws, wss)
    const hasProtocol = hasRecognizedProtocol(normalizedDomain);

    // Check if port was explicitly specified (e.g., :443, :8080)
    // Need to check before URL parsing because URL normalizes default ports
    const portMatch = normalizedDomain.match(/:(\d+)(\/|$|\?)/);
    const explicitPort = portMatch !== null;
    const explicitPortValue = portMatch ? portMatch[1] : null;

    // If no protocol, add one temporarily for URL parsing
    if (!hasProtocol) {
      normalizedDomain = `https://${normalizedDomain}`;
    }

    const url = new URL(normalizedDomain);

    // Additional validation that hostname isn't just protocol
    if (!url.hostname || emptyProtocols.some((p) => url.hostname === p.replace('://', ''))) {
      return null;
    }

    const hostname = url.hostname.replace(/^www\./i, '');

    return {
      hostname,
      protocol: hasProtocol ? (url.protocol as SupportedProtocol) : null,
      // Use the explicitly specified port, or null if no port was specified
      port: explicitPort ? explicitPortValue : null,
      explicitPort,
      isWildcard,
    };
  } catch {
    return null;
  }
}

/**
 * Checks if hostname matches an allowed pattern (supports wildcards).
 */
function hostnameMatches(inputHostname: string, allowedSpec: ParsedDomainSpec): boolean {
  if (allowedSpec.isWildcard) {
    // Extract base domain from wildcard (e.g., "*.example.com" -> "example.com")
    const baseDomain = allowedSpec.hostname.replace(/^\*\./, '');
    return inputHostname === baseDomain || inputHostname.endsWith(`.${baseDomain}`);
  }
  return inputHostname === allowedSpec.hostname;
}

/** Protocol sets for different use cases */
const HTTP_PROTOCOLS: SupportedProtocol[] = ['http:', 'https:'];
const MCP_PROTOCOLS: SupportedProtocol[] = ['http:', 'https:', 'ws:', 'wss:'];

function defaultPortForProtocol(protocol: SupportedProtocol | string | null): string {
  if (protocol === 'http:' || protocol === 'ws:') return '80';
  if (protocol === 'https:' || protocol === 'wss:') return '443';
  return '';
}

export function getEffectivePort(
  protocol: SupportedProtocol | string | null,
  port?: string | null,
): string {
  return normalizePort(port ? port : defaultPortForProtocol(protocol));
}

/**
 * Core domain validation logic with configurable protocol support.
 * SECURITY: When no allowedDomains is configured, blocks SSRF-prone targets.
 * @param domain - The domain to check (can include protocol/port)
 * @param allowedDomains - List of allowed domain patterns
 * @param supportedProtocols - Protocols to accept (others are rejected)
 * @param allowedAddresses - Optional admin exemption list of host:port pairs
 *   that bypass the private-IP block when no allowedDomains whitelist is active
 */
async function isDomainAllowedCore(
  domain: string,
  allowedDomains: string[] | null | undefined,
  supportedProtocols: SupportedProtocol[],
  allowedAddresses?: string[] | null,
): Promise<boolean> {
  const inputSpec = parseDomainSpec(domain);
  if (!inputSpec) {
    return false;
  }

  // SECURITY: Reject unsupported protocols (e.g., WebSocket for OpenAPI Actions)
  if (inputSpec.protocol !== null && !supportedProtocols.includes(inputSpec.protocol)) {
    return false;
  }

  /** If no domain restrictions configured, block SSRF targets but allow all else */
  if (!Array.isArray(allowedDomains) || !allowedDomains.length) {
    const effectivePort = getEffectivePort(inputSpec.protocol, inputSpec.port);
    /** SECURITY: Block SSRF-prone targets when no allowlist is configured */
    if (isSSRFTarget(inputSpec.hostname, allowedAddresses, effectivePort)) {
      return false;
    }
    /** SECURITY: Resolve hostname and block if it points to a private/reserved IP */
    if (await resolveHostnameSSRF(inputSpec.hostname, allowedAddresses, effectivePort)) {
      return false;
    }
    return true;
  }

  /** When allowedDomains is configured, check against the list with protocol/port matching */
  for (const allowedDomain of allowedDomains) {
    const allowedSpec = parseDomainSpec(allowedDomain);
    if (!allowedSpec) {
      continue;
    }

    // Skip allowedDomains with unsupported protocols for this context
    if (allowedSpec.protocol !== null && !supportedProtocols.includes(allowedSpec.protocol)) {
      continue;
    }

    // Check hostname match (with wildcard support)
    if (!hostnameMatches(inputSpec.hostname, allowedSpec)) {
      continue;
    }

    // If allowedSpec has protocol restriction, input must match
    if (allowedSpec.protocol !== null) {
      // Input must have protocol specified to match a protocol-restricted rule
      if (inputSpec.protocol === null || inputSpec.protocol !== allowedSpec.protocol) {
        continue;
      }
    }

    // If allowedSpec has explicit port restriction, input must have matching explicit port
    if (allowedSpec.explicitPort) {
      // Input must also have an explicit port that matches
      if (!inputSpec.explicitPort || inputSpec.port !== allowedSpec.port) {
        continue;
      }
    }

    // All specified constraints matched
    return true;
  }

  return false;
}

/**
 * Validates domain for OpenAPI Agent Actions (HTTP/HTTPS only).
 * SECURITY: WebSocket protocols are NOT allowed per OpenAPI specification.
 * @param domain - The domain to check (can include protocol/port)
 * @param allowedDomains - List of allowed domain patterns
 * @param allowedAddresses - Optional admin exemption list of host:port pairs
 */
export async function isActionDomainAllowed(
  domain?: string | null,
  allowedDomains?: string[] | null,
  allowedAddresses?: string[] | null,
): Promise<boolean> {
  if (!domain || typeof domain !== 'string') {
    return false;
  }
  return isDomainAllowedCore(domain, allowedDomains, HTTP_PROTOCOLS, allowedAddresses);
}

/**
 * Extracts full domain spec (protocol://hostname:port) from MCP server config URL.
 * Returns the full origin for proper protocol/port matching against allowedDomains.
 * @returns The full origin string, or null when:
 *   - No `url` property, non-string, or empty (stdio transport — always allowed upstream)
 *   - URL string present but cannot be parsed (rejected fail-closed upstream when allowlist active)
 *   Callers must distinguish these two null cases; see {@link isMCPDomainAllowed}.
 * @param config - MCP server configuration (accepts any config with optional url field)
 */
export function extractMCPServerDomain(config: Record<string, unknown>): string | null {
  const url = config.url;
  // Stdio transports don't have URLs - always allowed
  if (!url || typeof url !== 'string') {
    return null;
  }

  try {
    const parsedUrl = new URL(url);
    // Return full origin (protocol://hostname:port) for proper domain validation
    // This allows admins to restrict by protocol/port in allowedDomains
    return parsedUrl.origin;
  } catch {
    return null;
  }
}

/**
 * Validates MCP server domain against allowedDomains.
 * Supports HTTP, HTTPS, WS, and WSS protocols (per MCP specification).
 * Stdio transports (no URL) are always allowed.
 * Configs with a non-empty URL that cannot be parsed are rejected fail-closed when an
 * allowlist is active, preventing template placeholders (e.g. `{{HOST}}`) from bypassing
 * domain validation after `processMCPEnv` resolves them at connection time.
 * When no allowlist is configured, unparseable URLs fall through to connection-level
 * SSRF protection (`createSSRFSafeUndiciConnect`).
 * @param config - MCP server configuration with optional url field
 * @param allowedDomains - List of allowed domains (with wildcard support)
 */
export async function isMCPDomainAllowed(
  config: Record<string, unknown>,
  allowedDomains?: string[] | null,
  allowedAddresses?: string[] | null,
): Promise<boolean> {
  const domain = extractMCPServerDomain(config);
  const hasAllowlist = Array.isArray(allowedDomains) && allowedDomains.length > 0;

  const hasExplicitUrl =
    Object.prototype.hasOwnProperty.call(config, 'url') &&
    typeof config.url === 'string' &&
    config.url.trim().length > 0;

  if (!domain && hasExplicitUrl && hasAllowlist) {
    return false;
  }

  // Stdio transports (no URL) are always allowed
  if (!domain) {
    return true;
  }

  // Use MCP_PROTOCOLS (HTTP/HTTPS/WS/WSS) for MCP server validation
  return isDomainAllowedCore(domain, allowedDomains, MCP_PROTOCOLS, allowedAddresses);
}

/**
 * Checks whether an OAuth URL matches any entry in the MCP allowedDomains list,
 * honoring protocol and port constraints when specified by the admin.
 *
 * Mirrors the allowlist-matching logic of {@link isDomainAllowedCore} (hostname,
 * protocol, and explicit-port checks) but is synchronous — no DNS resolution is
 * needed because the caller is deciding whether to *skip* the subsequent
 * SSRF/DNS checks, not replace them.
 *
 * @remarks `parseDomainSpec` normalizes `www.` prefixes, so both the input URL
 * and allowedDomains entries starting with `www.` are matched without that prefix.
 */
export function isOAuthUrlAllowed(
  url: string,
  allowedDomains?: string[] | null,
  allowedAddresses?: string[] | null,
): boolean {
  /**
   * Require an absolute URL with an explicit scheme. `parseDomainSpec` is
   * lenient: it prepends `https://` to schemeless inputs so a value like
   * `10.0.0.5/oauth` would otherwise short-circuit the trust-bypass via
   * `allowedAddresses` and skip `validateOAuthUrl`'s strict `new URL(url)`
   * parse-or-throw check, only to fail later in OAuth discovery with a less
   * clear error. Falling through here lets the caller's strict parse run.
   */
  try {
    new URL(url);
  } catch {
    return false;
  }

  const inputSpec = parseDomainSpec(url);
  if (!inputSpec) {
    return false;
  }

  /**
   * When `allowedDomains` is configured, treat it as the authoritative bound
   * on which OAuth URLs may bypass the SSRF/DNS check. `allowedAddresses` is
   * an SSRF-private-IP exemption, not a domain allowlist — letting it
   * short-circuit here would broaden a strict admin-configured OAuth scope
   * (e.g. an MCP server could advertise OAuth endpoints at any address the
   * admin permitted for an unrelated reason like a self-hosted LLM).
   */
  if (Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    for (const allowedDomain of allowedDomains) {
      const allowedSpec = parseDomainSpec(allowedDomain);
      if (!allowedSpec) {
        continue;
      }
      if (!hostnameMatches(inputSpec.hostname, allowedSpec)) {
        continue;
      }
      if (allowedSpec.protocol !== null) {
        if (inputSpec.protocol === null || inputSpec.protocol !== allowedSpec.protocol) {
          continue;
        }
      }
      if (allowedSpec.explicitPort) {
        if (!inputSpec.explicitPort || inputSpec.port !== allowedSpec.port) {
          continue;
        }
      }
      return true;
    }
    return false;
  }

  /**
   * No `allowedDomains` configured: the address exemption may permit specific
   * private host:port pairs (matches the semantics of `validateOAuthUrl`'s
   * downstream SSRF checks, which also consult `allowedAddresses`).
   */
  return isAddressAllowed(
    inputSpec.hostname,
    allowedAddresses,
    getEffectivePort(inputSpec.protocol, inputSpec.port),
  );
}

/** Matches ErrorTypes.INVALID_BASE_URL — string literal avoids build-time dependency on data-provider */
const INVALID_BASE_URL_TYPE = 'invalid_base_url';

function throwInvalidBaseURL(message: string): never {
  throw new Error(JSON.stringify({ type: INVALID_BASE_URL_TYPE, message }));
}

/**
 * Validates that a user-provided endpoint URL does not target private/internal addresses.
 * Throws if the URL is unparseable, uses a non-HTTP(S) scheme, targets a known SSRF hostname,
 * or DNS-resolves to a private IP.
 *
 * When `allowedAddresses` is provided, hostname/IP + port pairs are matched
 * against the list — admin-exempted private services bypass the SSRF block.
 * This lets operators permit known-good private services (self-hosted Ollama,
 * Docker host, etc.) without disabling protection for every port on the same host.
 *
 * @note DNS rebinding: validation performs a single DNS lookup. An adversary controlling
 *   DNS with TTL=0 could respond with a public IP at validation time and a private IP
 *   at request time. This is an accepted limitation of point-in-time DNS checks.
 * @note Fail-open on DNS errors: a resolution failure here implies a failure at request
 *   time as well, matching {@link resolveHostnameSSRF} semantics.
 */
export async function validateEndpointURL(
  url: string,
  endpoint: string,
  allowedAddresses?: string[] | null,
): Promise<void> {
  let hostname: string;
  let protocol: string;
  let port: string;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    protocol = parsed.protocol;
    port = getEffectivePort(protocol, parsed.port);
  } catch {
    throwInvalidBaseURL(`Invalid base URL for ${endpoint}: unable to parse URL.`);
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    throwInvalidBaseURL(`Invalid base URL for ${endpoint}: only HTTP and HTTPS are permitted.`);
  }

  if (isSSRFTarget(hostname, allowedAddresses, port)) {
    throwInvalidBaseURL(`Base URL for ${endpoint} targets a restricted address.`);
  }

  if (await resolveHostnameSSRF(hostname, allowedAddresses, port)) {
    throwInvalidBaseURL(`Base URL for ${endpoint} resolves to a restricted address.`);
  }
}
