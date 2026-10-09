import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { AxiosRequestConfig } from 'axios';
import type { LookupFunction } from 'node:net';
import {
  normalizePort,
  normalizeAllowedAddressesSet,
  isAddressInAllowedSet,
} from './allowedAddresses';
import { isPrivateIP } from './ip';

type LookupResult = string | dns.LookupAddress[];

function createSSRFLookupError(hostname: string, address: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`SSRF protection: ${hostname} resolved to blocked address ${address}`),
    { code: 'ESSRF' },
  ) as NodeJS.ErrnoException;
}

function getBlockedLookupAddress(
  lookupResult: LookupResult,
  hostnameAllowed: boolean,
  exemptSet: Set<string> | null,
  normalizedPort: string,
): string | null {
  if (hostnameAllowed) {
    return null;
  }

  const addresses = Array.isArray(lookupResult)
    ? lookupResult.map(({ address }) => address)
    : [lookupResult];

  return (
    addresses.find(
      (address) =>
        isPrivateIP(address) && !isAddressInAllowedSet(address, exemptSet, normalizedPort),
    ) ?? null
  );
}

/**
 * Builds a DNS lookup wrapper that blocks resolution to private/reserved IP
 * addresses. When `allowedAddresses` is provided, hostname/IP + port pairs
 * matching the list bypass the block — admins can permit known-good internal
 * services (self-hosted Ollama, Docker host, etc.) without disabling SSRF
 * protection for every port on the same host.
 *
 * The exemption list is pre-normalized once at construction so the per-
 * connection lookup runs an O(1) Set membership check. Normalization and
 * scoping rules live in `./allowedAddresses`, shared with the preflight
 * helper in `./domain` so the two layers cannot diverge.
 */
function buildSSRFSafeLookup(
  allowedAddresses?: string[] | null,
  port?: string | number | null,
): LookupFunction {
  const exemptSet = normalizeAllowedAddressesSet(allowedAddresses);
  const normalizedPort = normalizePort(port);
  return (hostname, options, callback) => {
    const hostnameAllowed = isAddressInAllowedSet(hostname, exemptSet, normalizedPort);
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, '', 0);
        return;
      }

      const blockedAddress = getBlockedLookupAddress(
        address,
        hostnameAllowed,
        exemptSet,
        normalizedPort,
      );
      if (blockedAddress) {
        callback(createSSRFLookupError(hostname, blockedAddress), blockedAddress, family);
        return;
      }

      callback(null, address, family);
    });
  };
}

/** Default lookup with no exemptions. Kept for callers that don't need allowedAddresses. */
const ssrfSafeLookup: LookupFunction = buildSSRFSafeLookup();

/** Connect options Node hands to `createConnection`; typed here because the seam is untyped. */
interface ConnectOptions {
  host?: unknown;
  port?: unknown;
  defaultPort?: unknown;
  socketPath?: unknown;
  lookup?: LookupFunction;
}

/** Internal agent shape exposing createConnection (exists at runtime but not in TS types) */
type AgentInternal = {
  createConnection: (options: ConnectOptions, oncreate?: unknown) => unknown;
};

function getConnectionPort(options: ConnectOptions): string {
  return normalizePort(options.port ?? options.defaultPort);
}

/**
 * Rejects a connection whose host is already an IP literal in blocked space.
 *
 * Node resolves nothing for a literal host, so the SSRF lookup below never runs for one.
 * Redirect hops reach this same `createConnection`, so checking here is what covers a
 * redirect whose target is a literal private address. Opt-in: a caller that reaches a
 * proxy or a deliberate private service by literal address must exempt it first, so
 * enabling this by default would break existing configurations.
 */
function assertLiteralHostAllowed(
  options: ConnectOptions,
  allowedAddresses?: string[] | null,
): void {
  /** A unix socket carries no host to validate, and these agents exist for http(s) URLs only. */
  if (options.socketPath != null) {
    throw createSSRFLookupError('socketPath', String(options.socketPath));
  }

  const host = typeof options.host === 'string' ? options.host.replace(/^\[|\]$/g, '') : '';
  if (host.length === 0 || !isIP(host)) {
    return;
  }

  const port = getConnectionPort(options);
  if (isAddressInAllowedSet(host, normalizeAllowedAddressesSet(allowedAddresses), port)) {
    return;
  }
  if (isPrivateIP(host)) {
    throw createSSRFLookupError(host, host);
  }
}

export interface SSRFProtectionOptions {
  /** Also reject IP-literal hosts, covering literal destinations and literal redirect targets. */
  blockLiteralHosts?: boolean;
}

/** Patches an agent instance to inject SSRF-safe DNS lookup at connect time */
function withSSRFProtection<T extends http.Agent>(
  agent: T,
  allowedAddresses?: string[] | null,
  options?: SSRFProtectionOptions,
): T {
  const internal = agent as unknown as AgentInternal;
  const origCreate = internal.createConnection.bind(agent);
  internal.createConnection = (connectOptions: ConnectOptions, oncreate?: unknown) => {
    if (options?.blockLiteralHosts) {
      assertLiteralHostAllowed(connectOptions, allowedAddresses);
    }
    connectOptions.lookup = allowedAddresses?.length
      ? buildSSRFSafeLookup(allowedAddresses, getConnectionPort(connectOptions))
      : ssrfSafeLookup;
    return origCreate(connectOptions, oncreate);
  };
  return agent;
}

/**
 * Creates HTTP and HTTPS agents that block TCP connections to private/reserved IP addresses.
 * Provides TOCTOU-safe SSRF protection by validating the resolved IP at connect time,
 * preventing DNS rebinding attacks where a hostname resolves to a public IP during
 * pre-validation but to a private IP when the actual connection is made.
 *
 * @param allowedAddresses - Optional admin exemption list of host:port pairs that bypass the block.
 * @param agentOptions - Agent options, e.g. `{ keepAlive: true }` to retain pooling that the
 *   default global agents provide and a bare `new http.Agent()` does not.
 */
export function createSSRFSafeAgents(
  allowedAddresses?: string[] | null,
  agentOptions?: (http.AgentOptions & https.AgentOptions) | null,
  protection?: SSRFProtectionOptions,
): {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
} {
  const options = agentOptions ?? undefined;
  return {
    httpAgent: withSSRFProtection(new http.Agent(options), allowedAddresses, protection),
    httpsAgent: withSSRFProtection(new https.Agent(options), allowedAddresses, protection),
  };
}

/**
 * Returns undici-compatible `connect` options with SSRF-safe DNS lookup.
 * Pass the result as the `connect` property when constructing an undici `Agent`.
 *
 * @param allowedAddresses - Optional admin exemption list of host:port pairs that bypass the block.
 */
export function createSSRFSafeUndiciConnect(
  allowedAddresses?: string[] | null,
  port?: string | number | null,
): {
  lookup: LookupFunction;
} {
  const lookup = allowedAddresses?.length
    ? buildSSRFSafeLookup(allowedAddresses, port)
    : ssrfSafeLookup;
  return { lookup };
}

/**
 * Attaches SSRF-safe HTTP(S) agents to an axios config for a direct request.
 * Rejects non-http(s) (and unparseable) target urls, since the agents validate
 * the resolved IP at connect time but never inspect the scheme. Sets
 * `maxRedirects: 0` unconditionally so a redirect cannot bypass that check, and
 * leaves the agents untouched when a proxy or agent is already set.
 *
 * @param config - The axios request config to mutate.
 * @param url - The request target URL (http/https only).
 * @param allowedAddresses - Optional admin exemption list of host:port pairs.
 */
export function applySSRFSafeAgentIfDirect(
  config: AxiosRequestConfig,
  url: string,
  allowedAddresses?: string[] | null,
): AxiosRequestConfig {
  const { protocol, hostname, port } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme for SSRF-guarded request: ${protocol}`);
  }

  config.maxRedirects = 0;

  // Node skips the agent's custom DNS lookup for IP-literal hosts, and a configured proxy
  // connects on our behalf without running that check, so a literal private IP (e.g.
  // http://169.254.169.254) must be rejected before any proxy or agent early return.
  const literalHost = hostname.replace(/^\[|\]$/g, '');
  if (isIP(literalHost)) {
    const exemptSet = normalizeAllowedAddressesSet(allowedAddresses);
    const normalizedPort = normalizePort(port || (protocol === 'https:' ? '443' : '80'));
    const hostnameAllowed = isAddressInAllowedSet(literalHost, exemptSet, normalizedPort);
    const blockedAddress = getBlockedLookupAddress(
      literalHost,
      hostnameAllowed,
      exemptSet,
      normalizedPort,
    );
    if (blockedAddress) {
      throw createSSRFLookupError(literalHost, blockedAddress);
    }
  }

  if (config.httpsAgent || config.httpAgent || config.proxy) {
    return config;
  }

  const { httpAgent, httpsAgent } = createSSRFSafeAgents(allowedAddresses);
  config.httpAgent = httpAgent;
  config.httpsAgent = httpsAgent;
  return config;
}
