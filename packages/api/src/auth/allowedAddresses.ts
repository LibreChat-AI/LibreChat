/**
 * Shared normalization for `allowedAddresses` entries used by both the
 * preflight SSRF helpers in `domain.ts` and the connect-time DNS lookup in
 * `agent.ts`. Keeping this in one module avoids subtle divergence between
 * the two paths (e.g. one rejecting tabs but not the other), which would
 * weaken defense-in-depth.
 *
 * SECURITY — scoped to private IP space:
 *  - Reject URLs (`://`), paths/CIDR (`/`), all whitespace (`\s`), and
 *    bare host/IP shapes. Entries must be scoped as `host:port` or
 *    `[ipv6]:port` so an exemption cannot silently trust every service on a
 *    private host. The runtime guard exists so a list assembled
 *    programmatically never silently grants exemption.
 *  - Drop public IP literals — public IPs are never SSRF targets, so an
 *    exemption there has no defensive purpose and must not grant "trusted"
 *    status. Hostnames pass through; their resolved IP is checked
 *    separately by callers (e.g. `resolveHostnameSSRF`).
 *  - Drop entries carrying `$`, `{` or `}`. Environment references are
 *    resolved once from the server environment by the config loader
 *    (`resolveAllowedAddressesEnv`); any that reach this parser came from
 *    somewhere else (DB overrides, programmatic lists) and must not match.
 */
import { isIP } from 'node:net';
import { isSensitiveEnvVar, parseAllowedAddressEnvReference } from 'librechat-data-provider';
import { isPrivateIP } from './ip';

const ADDRESS_PORT_SEPARATOR = '\0';
const MAX_PORT = 65535;

interface AddressPort {
  address: string;
  port: string;
}

/** Returns true when the (already-normalized) string looks like an IPv4 or IPv6 literal. */
export function isIPLiteral(normalized: string): boolean {
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(normalized)) {
    return true;
  }
  return normalized.includes(':');
}

/**
 * Detects `host:port` and `[ipv6]:port` shapes. Bare `::1`, `[::1]`, and
 * IPv6 literals with no port are not matched.
 */
export function looksLikeHostPort(entry: string): boolean {
  if (/^\[[^\]]+\]:\d+$/.test(entry)) return true;
  const colonCount = (entry.match(/:/g) ?? []).length;
  if (colonCount !== 1) return false;
  return /^[^:]+:\d+$/.test(entry);
}

export function normalizePort(port: unknown): string {
  if (typeof port !== 'string' && typeof port !== 'number') return '';
  const portString = String(port).trim();
  if (!/^\d+$/.test(portString)) return '';
  const parsed = Number(portString);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PORT) return '';
  return String(parsed);
}

function addressPortKey(address: string, port: string): string {
  return `${address}${ADDRESS_PORT_SEPARATOR}${port}`;
}

/**
 * Canonicalizes an IP literal to WHATWG-URL form so allowlist entries and targets (which pass
 * through `new URL`) compare identically, covering IPv4-mapped and expanded/ULA IPv6 forms.
 */
function canonicalizeIPLiteral(value: string): string {
  const family = isIP(value);
  if (family === 0) return value;
  try {
    const host = family === 6 ? `[${value}]` : value;
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return value;
  }
}

function normalizeAddressCandidate(candidate: string): string {
  const normalized = candidate
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, '');
  if (!normalized) return '';
  if (isIPLiteral(normalized)) {
    const canonical = canonicalizeIPLiteral(normalized);
    if (!isPrivateIP(canonical)) return '';
    return canonical;
  }
  return normalized;
}

function parseAddressPortEntry(entry: string): AddressPort | null {
  const trimmed = entry.toLowerCase().trim();
  const bracketedIPv6 = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  const hostPort = bracketedIPv6 ? null : trimmed.match(/^([^:]+):(\d+)$/);
  const address = bracketedIPv6?.[1] ?? hostPort?.[1] ?? '';
  const port = normalizePort(bracketedIPv6?.[2] ?? hostPort?.[2] ?? '');
  if (!address || !port) return null;
  const normalizedAddress = normalizeAddressCandidate(address);
  if (!normalizedAddress) return null;
  return { address: normalizedAddress, port };
}

/**
 * Normalizes a single `allowedAddresses` entry. Returns the canonical form
 * when the entry is acceptable, or `''` when it must be ignored (URL, path,
 * whitespace, unresolved `${...}` reference, bare host/IP, public IP literal,
 * invalid port, or empty after trimming).
 */
export function normalizeAddressEntry(entry: unknown): string {
  if (typeof entry !== 'string') return '';
  if (entry.includes('://') || entry.includes('/') || /[\s${}]/.test(entry)) return '';
  const parsed = parseAddressPortEntry(entry);
  if (!parsed) return '';
  return addressPortKey(parsed.address, parsed.port);
}

/**
 * Pre-normalizes an admin list into a `Set<string>` for O(1) membership
 * checks on the connect-time hot path. Entries that fail validation are
 * silently dropped here; the Zod schema reports them at config load.
 */
export function normalizeAllowedAddressesSet(
  allowedAddresses?: string[] | null,
): Set<string> | null {
  if (!Array.isArray(allowedAddresses) || allowedAddresses.length === 0) {
    return null;
  }
  const set = new Set<string>();
  for (const entry of allowedAddresses) {
    const normalized = normalizeAddressEntry(entry);
    if (normalized) set.add(normalized);
  }
  return set.size > 0 ? set : null;
}

/**
 * Checks whether a hostname or IP literal should be exempted from the SSRF
 * block. Mirrors the scoping rules of `normalizeAddressEntry`: the exemption
 * must match both address and port, and an IP candidate must itself be private
 * to be exemptable.
 */
export function isAddressInAllowedSet(
  candidate: string,
  set: Set<string> | null,
  port?: string | number | null,
): boolean {
  if (!set) return false;
  const parsedCandidate = port == null ? parseAddressPortEntry(candidate) : null;
  const normalizedPort = parsedCandidate?.port ?? normalizePort(port);
  if (!normalizedPort) return false;
  const normalizedAddress = parsedCandidate?.address ?? normalizeAddressCandidate(candidate);
  if (!normalizedAddress) return false;
  return set.has(addressPortKey(normalizedAddress, normalizedPort));
}

export type AllowedAddressEnvDropReason = 'unset' | 'invalid' | 'sensitive';

export interface AllowedAddressEnvDrop {
  entry: string;
  varName: string;
  reason: AllowedAddressEnvDropReason;
}

export interface AllowedAddressesEnvResolution {
  addresses: string[];
  dropped: AllowedAddressEnvDrop[];
}

/**
 * Replaces `${VAR}` and `${VAR}:port` entries with values from `env`, which must be the server's
 * own environment. Literal entries pass through unchanged. A reference is dropped when its
 * variable is unset or empty, names an infrastructure secret, or resolves to something the
 * runtime parser would reject (URL, path, missing port, public IP literal, nested reference),
 * so an unresolved placeholder never reaches the effective list and a deployment without the
 * variable keeps every other exemption.
 */
export function resolveAllowedAddressesEnv(
  entries: readonly string[],
  env: NodeJS.ProcessEnv,
): AllowedAddressesEnvResolution {
  const addresses: string[] = [];
  const dropped: AllowedAddressEnvDrop[] = [];
  for (const entry of entries) {
    const reference = typeof entry === 'string' ? parseAllowedAddressEnvReference(entry) : null;
    if (!reference) {
      addresses.push(entry);
      continue;
    }
    const { varName, port } = reference;
    if (isSensitiveEnvVar(varName)) {
      dropped.push({ entry, varName, reason: 'sensitive' });
      continue;
    }
    const value = env[varName]?.trim();
    if (!value) {
      dropped.push({ entry, varName, reason: 'unset' });
      continue;
    }
    const resolved = port ? `${value}:${port}` : value;
    if (!normalizeAddressEntry(resolved)) {
      dropped.push({ entry, varName, reason: 'invalid' });
      continue;
    }
    addresses.push(resolved);
  }
  return { addresses, dropped };
}
