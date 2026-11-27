/**
 * RFC 6749 §5.1 makes `expires_in` only RECOMMENDED, so a token response may legally omit it, and
 * providers have been observed sending it as a string. Deriving a lifetime from the raw field is
 * therefore unsafe: `undefined * 1000` is `NaN`, and `NaN` is neither an error nor a default.
 *
 * A `NaN` cache TTL means an entry that never expires. `@keyv/redis` writes the key without `PX`
 * because `NaN` is falsy, and Keyv's own expiry checks compare with `>`, which is always false
 * against `NaN`. The namespace default does not stand in either, since Keyv applies it with `??=`
 * and `NaN` is neither `null` nor `undefined`. A `NaN` timestamp is just as sharp: `new Date(NaN)`
 * is an Invalid Date and `toISOString()` on it throws `RangeError`.
 *
 * Every lifetime derived from a token response goes through here so the rule has one home.
 */

/**
 * Fallback lifetime for a token response that declares none. One hour matches every hand-written
 * default this helper replaces, and is short enough that a wrongly-guessed lifetime self-corrects.
 */
export const DEFAULT_OAUTH_TOKEN_TTL_SECONDS = 3600;

/**
 * Margin a credential needs to survive the trip to whoever will use it. A token served inside this
 * window expires in transit and is rejected downstream, so it is treated as already gone — both
 * when validating the user's own federated token (`isOpenIDTokenValid`, `isIdTokenCurrent`) and
 * when caching a token obtained by exchange. Lives here, with the rest of the lifetime math, so a
 * consumer that stubs OpenID token validation cannot leave the arithmetic reading `undefined`.
 */
export const OPENID_EXPIRY_BUFFER_SECONDS = 30;

/**
 * Floor for a cache TTL derived from an already-elapsed lifetime. Keyv reads a TTL of exactly `0`
 * as "no expiry" (`data.ttl === 0` becomes `undefined`), so a credential the provider declared
 * expired must never be written as `0` — that is the very failure this module exists to prevent.
 */
const EXPIRED_CACHE_TTL_MS = 1;

/**
 * Floor for a credential that is still alive but whose remaining lifetime is shorter than the
 * in-transit buffer. Distinct from {@link EXPIRED_CACHE_TTL_MS}: a lifetime the provider declared
 * elapsed is dead and must not be reused, while a short one is real and gets a usable moment
 * rather than a value that expires before the caller can act on it.
 */
const MIN_LIVE_TOKEN_TTL_MS = 1000;

/**
 * Longest lifetime that can still produce a valid `Date`. The ECMAScript time value range ends at
 * ±8.64e15 ms, and every derived timestamp adds `Date.now()`, so the bound is halved to leave room
 * for it. A provider sending something beyond this — `"1e13"` seconds is roughly 317,000 years — is
 * not describing a credential lifetime, and accepting it would yield the Invalid Date this module
 * exists to prevent. Such a value is reported as unusable so callers take their fallback.
 */
const MAX_EXPIRES_IN_SECONDS = 4_320_000_000_000;

function parseExpiresIn(expiresIn: unknown): number | undefined {
  if (typeof expiresIn === 'number') {
    return expiresIn;
  }

  if (typeof expiresIn !== 'string') {
    return undefined;
  }

  /** `Number` over `parseInt`, which truncates a complete numeric string such as `"3.6e3"` to `3` */
  const trimmed = expiresIn.trim();
  return trimmed.length === 0 ? undefined : Number(trimmed);
}

/**
 * The lifetime a token response declares, in seconds, or `undefined` when it declares none usable.
 *
 * A non-positive value is preserved rather than discarded: the provider is stating the credential
 * is already expired, which is information, and collapsing it into "unknown" would hand it the
 * fallback lifetime and keep a dead credential alive.
 */
export function normalizeExpiresIn(expiresIn: unknown): number | undefined {
  const parsed = parseExpiresIn(expiresIn);
  if (parsed == null || !Number.isFinite(parsed)) {
    return undefined;
  }

  return Math.abs(parsed) <= MAX_EXPIRES_IN_SECONDS ? parsed : undefined;
}

/**
 * Cache TTL in milliseconds for a token response. A provider that omits `expires_in` gets
 * `fallbackSeconds` rather than an entry that outlives the credential it holds; one that declares
 * an elapsed lifetime gets the shortest positive TTL rather than `0`, which Keyv reads as no expiry.
 *
 * The declared lifetime is shortened by {@link OPENID_EXPIRY_BUFFER_SECONDS} — the same margin
 * `isOpenIDTokenValid` applies to the user's own federated token. A credential served in the final
 * seconds of its life expires in transit and is rejected downstream, and because the read side
 * re-serves whatever the cache still holds, that entry must be gone before the credential is.
 * An unknown lifetime takes the fallback unshortened: there is no declared expiry to protect.
 */
export function getTokenCacheTtlMs(expiresIn: unknown, fallbackSeconds: number): number {
  const seconds = normalizeExpiresIn(expiresIn);
  if (seconds == null) {
    return fallbackSeconds * 1000;
  }
  if (seconds <= 0) {
    return EXPIRED_CACHE_TTL_MS;
  }
  return Math.max((seconds - OPENID_EXPIRY_BUFFER_SECONDS) * 1000, MIN_LIVE_TOKEN_TTL_MS);
}

/**
 * Absolute expiry in epoch milliseconds for a token response, preferring an expiry the caller
 * already holds. `fallbackSeconds` covers a response that declares no usable lifetime.
 */
export function getTokenExpiresAtMs({
  expiresAt,
  expiresIn,
  fallbackSeconds = DEFAULT_OAUTH_TOKEN_TTL_SECONDS,
  now,
}: {
  expiresAt?: number | null;
  expiresIn?: unknown;
  fallbackSeconds?: number;
  now: number;
}): number {
  if (expiresAt != null && Number.isFinite(expiresAt)) {
    return expiresAt;
  }
  return now + (normalizeExpiresIn(expiresIn) ?? fallbackSeconds) * 1000;
}

/**
 * The expiry a downstream consumer should honour: the real one pulled back by the in-transit
 * buffer, so a credential handed on with this stamp cannot be accepted into its final seconds.
 */
export function getSkewedTokenExpiresAtMs(expiresAt: number, now: number): number {
  /** An expiry already in the past is the provider saying the credential is dead. Flooring it to a
   *  moment in the future would hand a consumer a token that cannot work, so it stays elapsed and
   *  the caller rejects the exchange instead of failing downstream. */
  if (expiresAt <= now) {
    return expiresAt;
  }
  return Math.max(now + MIN_LIVE_TOKEN_TTL_MS, expiresAt - OPENID_EXPIRY_BUFFER_SECONDS * 1000);
}

/** Cache TTL for a token whose absolute expiry is already known, buffered as above. */
export function getSkewedTokenCacheTtlMs(expiresAt: number, now: number): number {
  if (expiresAt <= now) {
    return EXPIRED_CACHE_TTL_MS;
  }
  return Math.max(MIN_LIVE_TOKEN_TTL_MS, expiresAt - now - OPENID_EXPIRY_BUFFER_SECONDS * 1000);
}

/**
 * Whether a cached credential still has enough life to survive the trip downstream. A cache entry
 * that outlived its TTL check — a shared store with a coarser clock, an entry written before the
 * buffer existed — is rejected here rather than handed out to fail at the far end.
 */
export function hasUsableTokenExpiry(expiresAt?: number | null, now: number = Date.now()): boolean {
  return (
    expiresAt != null &&
    Number.isFinite(expiresAt) &&
    expiresAt > now + OPENID_EXPIRY_BUFFER_SECONDS * 1000
  );
}

/**
 * Absolute expiry for a token response, or `undefined` when its lifetime is unknown. Callers store
 * nothing rather than an Invalid Date, so an unknown expiry stays distinguishable from an elapsed
 * one — an elapsed lifetime still yields a past timestamp, so callers refresh instead of guessing.
 */
export function getTokenExpiresAt(expiresIn: unknown): Date | undefined {
  const seconds = normalizeExpiresIn(expiresIn);
  return seconds == null ? undefined : new Date(Date.now() + seconds * 1000);
}
