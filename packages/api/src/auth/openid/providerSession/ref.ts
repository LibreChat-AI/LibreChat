import { createHash } from 'crypto';
import type { ProviderSessionRef } from 'librechat-data-provider';
import { resolveProviderSessionIssuer } from '~/auth/openid';

/** The subset of verified claims a provider session reference is extracted from. */
export interface ProviderSessionClaims {
  sid?: unknown;
  [claim: string]: unknown;
}

/** Short, non-reversible-in-practice fingerprint for a `sid` in a log line. Never log the raw value. */
export function hashProviderSessionId(sid: string): string {
  return createHash('sha256').update(sid).digest('hex').slice(0, 12);
}

/** Type guard for a provider-session reference read back from an untrusted source (a signed
 *  cookie payload, a stored document). */
export function isProviderSessionRef(value: unknown): value is ProviderSessionRef {
  const ref = value as Partial<ProviderSessionRef> | null | undefined;
  return (
    typeof ref?.issuer === 'string' &&
    typeof ref?.clientId === 'string' &&
    typeof ref?.sid === 'string'
  );
}

/** The credential's expiry: `now` plus the longest of the given lifetimes. */
export function providerSessionCredentialExpiry(now: Date, ...lifetimesMs: number[]): Date {
  const longestMs = lifetimesMs.reduce((max, lifetimeMs) => Math.max(max, lifetimeMs), 0);
  return new Date(now.getTime() + longestMs);
}

/** Extracts the provider-session reference from verified claims. `issuer` keys on the claims'
 *  own `iss` when the configured issuer is a `{tenantid}` template it matches, so each tenant
 *  gets its own reference; otherwise it is the configured issuer, normalized as login lookup
 *  does. Returns `null` when `sid` is missing or not a non-empty string. */
export function extractProviderSessionRef(
  claims: ProviderSessionClaims | null | undefined,
  { issuer, clientId }: { issuer: string | undefined; clientId: string },
): ProviderSessionRef | null {
  const sid = claims?.sid;
  if (typeof sid !== 'string' || sid.length === 0) {
    return null;
  }

  const tokenIssuer = claims?.iss;
  const resolvedIssuer = resolveProviderSessionIssuer(
    issuer,
    typeof tokenIssuer === 'string' ? tokenIssuer : undefined,
  );
  if (!resolvedIssuer) {
    return null;
  }

  return { issuer: resolvedIssuer, clientId, sid };
}

function refsEqual(a: ProviderSessionRef, b: ProviderSessionRef): boolean {
  return a.issuer === b.issuer && a.clientId === b.clientId && a.sid === b.sid;
}

/** True only when both refs are non-null and every field matches. */
export function isSameProviderSessionRef(
  a: ProviderSessionRef | null | undefined,
  b: ProviderSessionRef | null | undefined,
): boolean {
  return a != null && b != null && refsEqual(a, b);
}

export type MergeProviderSessionRefResult =
  | { ok: true; ref: ProviderSessionRef | null }
  | { ok: false; code: 'CONFLICT' };

/** Reconciles the ref bound to a credential with a renewal's fresh claims: renewal never
 *  establishes or replaces an association on its own, only confirms it or conflicts. */
export function mergeProviderSessionRef(
  bound: ProviderSessionRef | null,
  refreshed: ProviderSessionRef | null,
): MergeProviderSessionRefResult {
  if (refreshed == null) {
    return { ok: true, ref: bound };
  }
  if (bound == null) {
    return { ok: true, ref: null };
  }
  if (refsEqual(bound, refreshed)) {
    return { ok: true, ref: bound };
  }
  return { ok: false, code: 'CONFLICT' };
}
