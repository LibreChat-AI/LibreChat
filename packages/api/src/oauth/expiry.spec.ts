import {
  DEFAULT_OAUTH_TOKEN_TTL_SECONDS,
  getSkewedTokenCacheTtlMs,
  getSkewedTokenExpiresAtMs,
  getTokenCacheTtlMs,
  getTokenExpiresAt,
  getTokenExpiresAtMs,
  hasUsableTokenExpiry,
  normalizeExpiresIn,
  OPENID_EXPIRY_BUFFER_SECONDS,
} from './expiry';

describe('normalizeExpiresIn', () => {
  it('accepts a positive finite number of seconds', () => {
    expect(normalizeExpiresIn(3599)).toBe(3599);
    expect(normalizeExpiresIn(1)).toBe(1);
  });

  it('accepts a numeric string, as some providers send', () => {
    expect(normalizeExpiresIn('3599')).toBe(3599);
  });

  it('rejects an omitted lifetime', () => {
    expect(normalizeExpiresIn(undefined)).toBeUndefined();
    expect(normalizeExpiresIn(null)).toBeUndefined();
  });

  it('rejects NaN, which `undefined * 1000` produces and every naive guard admits', () => {
    expect(normalizeExpiresIn(NaN)).toBeUndefined();
    expect(normalizeExpiresIn('not-a-number')).toBeUndefined();
  });

  it('rejects a non-finite lifetime', () => {
    expect(normalizeExpiresIn(Infinity)).toBeUndefined();
    expect(normalizeExpiresIn(-Infinity)).toBeUndefined();
  });

  /**
   * Parsing the complete string is what makes this reachable — `parseInt('1e13', 10)` was `1` and
   * masked it. `1e13` seconds overruns the ECMAScript time range, so every derived timestamp would
   * be an Invalid Date whose `toISOString()` throws: the very failure this module removes.
   */
  it('rejects a lifetime that would overflow the Date range', () => {
    expect(normalizeExpiresIn('1e13')).toBeUndefined();
    expect(normalizeExpiresIn(1e13)).toBeUndefined();
    expect(normalizeExpiresIn(-1e13)).toBeUndefined();
    expect(normalizeExpiresIn(Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it('still accepts lifetimes far longer than any real credential', () => {
    const oneYear = 365 * 24 * 60 * 60;
    expect(normalizeExpiresIn(oneYear)).toBe(oneYear);
    expect(normalizeExpiresIn(oneYear * 100)).toBe(oneYear * 100);
  });

  /** An explicit non-positive value is the provider saying the credential is already dead, which is
   *  information — collapsing it into "unknown" would hand it the fallback lifetime and revive it. */
  it('preserves an explicitly elapsed lifetime rather than calling it unknown', () => {
    expect(normalizeExpiresIn(0)).toBe(0);
    expect(normalizeExpiresIn(-60)).toBe(-60);
    expect(normalizeExpiresIn('0')).toBe(0);
  });

  it('parses a complete numeric string, which parseInt would truncate', () => {
    expect(normalizeExpiresIn('3.6e3')).toBe(3600);
    expect(normalizeExpiresIn(' 3600 ')).toBe(3600);
  });

  it('rejects an empty or blank string rather than reading it as zero', () => {
    expect(normalizeExpiresIn('')).toBeUndefined();
    expect(normalizeExpiresIn('   ')).toBeUndefined();
  });

  it('rejects shapes that are neither number nor string', () => {
    expect(normalizeExpiresIn({})).toBeUndefined();
    expect(normalizeExpiresIn([3600])).toBeUndefined();
    expect(normalizeExpiresIn(true)).toBeUndefined();
  });
});

describe('getTokenCacheTtlMs', () => {
  it('converts a declared lifetime to milliseconds, less the in-transit buffer', () => {
    expect(getTokenCacheTtlMs(1800, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBe(
      (1800 - OPENID_EXPIRY_BUFFER_SECONDS) * 1000,
    );
  });

  /** The read side re-serves whatever is cached, so the entry must expire before the credential:
   *  a token handed out in its final seconds expires in transit and 401s downstream. */
  it('drops a credential from the cache before its last usable moment', () => {
    expect(getTokenCacheTtlMs(3600, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBeLessThan(3_600_000);
    expect(getTokenCacheTtlMs(3600, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBe(3_570_000);
  });

  /** A lifetime shorter than the buffer has no safe window left, but the credential is still real:
   *  it gets the minimum usable TTL rather than a negative one or the elapsed-credential floor. */
  it('floors a live lifetime shorter than the buffer instead of going negative', () => {
    expect(getTokenCacheTtlMs(10, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBe(1000);
    expect(getTokenCacheTtlMs(OPENID_EXPIRY_BUFFER_SECONDS, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBe(
      1000,
    );
  });

  /** An unknown lifetime has no declared expiry to protect, so the fallback is used unshortened */
  it('falls back rather than returning NaN when the provider omits `expires_in`', () => {
    expect(getTokenCacheTtlMs(undefined, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBe(3_600_000);
    expect(getTokenCacheTtlMs(NaN, 60)).toBe(60_000);
  });

  /** Keyv reads a TTL of exactly 0 as "no expiry", so an elapsed lifetime must not pass through raw */
  it('floors an elapsed lifetime to the shortest positive TTL, never 0', () => {
    expect(getTokenCacheTtlMs(0, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBe(1);
    expect(getTokenCacheTtlMs(-60, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).toBe(1);
  });

  it('does not hand an elapsed lifetime the fallback, which would revive a dead credential', () => {
    expect(getTokenCacheTtlMs(0, DEFAULT_OAUTH_TOKEN_TTL_SECONDS)).not.toBe(3_600_000);
  });

  it('never returns 0, which Keyv would store as no expiry', () => {
    for (const value of [undefined, null, NaN, Infinity, 0, -1, '0', 'abc', {}, '1e13', 1e300]) {
      const ttl = getTokenCacheTtlMs(value, DEFAULT_OAUTH_TOKEN_TTL_SECONDS);
      expect(ttl).toBeGreaterThan(0);
      expect(Number.isFinite(ttl)).toBe(true);
    }
  });

  /**
   * A NaN TTL is not a short TTL: `@keyv/redis` skips its `PX` branch because NaN is falsy, and
   * Keyv's own expiry checks compare with `>`, always false against NaN. The result is an entry
   * that outlives the credential it holds.
   */
  it('never returns NaN, whatever the provider sent', () => {
    for (const value of [undefined, null, NaN, Infinity, 0, -1, 'abc', {}]) {
      expect(Number.isFinite(getTokenCacheTtlMs(value, DEFAULT_OAUTH_TOKEN_TTL_SECONDS))).toBe(
        true,
      );
    }
  });
});

describe('getTokenExpiresAt', () => {
  it('returns an absolute expiry for a declared lifetime', () => {
    const before = Date.now();
    const expiresAt = getTokenExpiresAt(600);

    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it('returns undefined rather than an Invalid Date when the lifetime is unknown', () => {
    for (const value of [undefined, null, NaN, Infinity, 'abc', '']) {
      expect(getTokenExpiresAt(value)).toBeUndefined();
    }
  });

  /** An elapsed lifetime must stay elapsed, so callers refresh instead of treating it as unknown */
  it('returns a past timestamp for an explicitly elapsed lifetime', () => {
    const expiresAt = getTokenExpiresAt(0);

    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(getTokenExpiresAt(-60)!.getTime()).toBeLessThan(Date.now());
  });

  /** `new Date(NaN).toISOString()` throws `RangeError: Invalid time value`, which is the ActionService failure */
  it('never yields a value whose toISOString throws', () => {
    for (const value of [undefined, null, NaN, Infinity, 'abc', '', 0, -60, 3600, '1e13', 1e300]) {
      expect(() => getTokenExpiresAt(value)?.toISOString()).not.toThrow();
    }
  });
});

describe('getTokenExpiresAtMs', () => {
  const now = 1_700_000_000_000;

  it('prefers an absolute expiry the caller already holds', () => {
    expect(getTokenExpiresAtMs({ expiresAt: now + 120_000, expiresIn: 3600, now })).toBe(
      now + 120_000,
    );
  });

  it('derives an expiry from the declared lifetime when no absolute one is given', () => {
    expect(getTokenExpiresAtMs({ expiresIn: 300, now })).toBe(now + 300_000);
    expect(getTokenExpiresAtMs({ expiresAt: NaN, expiresIn: '120', now })).toBe(now + 120_000);
  });

  it('falls back when the provider declares no usable lifetime', () => {
    expect(getTokenExpiresAtMs({ expiresIn: undefined, now })).toBe(
      now + DEFAULT_OAUTH_TOKEN_TTL_SECONDS * 1000,
    );
    expect(getTokenExpiresAtMs({ expiresIn: 'abc', fallbackSeconds: 60, now })).toBe(now + 60_000);
  });

  /** An explicitly elapsed lifetime stays elapsed rather than taking the fallback */
  it('keeps an elapsed lifetime in the past', () => {
    expect(getTokenExpiresAtMs({ expiresIn: 0, now })).toBe(now);
    expect(getTokenExpiresAtMs({ expiresIn: -60, now })).toBe(now - 60_000);
  });
});

describe('skew helpers', () => {
  const now = 1_700_000_000_000;
  const bufferMs = OPENID_EXPIRY_BUFFER_SECONDS * 1000;

  it('pulls an expiry back by the in-transit buffer', () => {
    const expiresAt = now + 120_000;

    expect(getSkewedTokenExpiresAtMs(expiresAt, now)).toBe(now + 120_000 - bufferMs);
    expect(getSkewedTokenCacheTtlMs(expiresAt, now)).toBe(120_000 - bufferMs);
  });

  it('floors a live lifetime shorter than the buffer to a usable minimum, never 0', () => {
    const expiresAt = now + 10_000;

    expect(getSkewedTokenExpiresAtMs(expiresAt, now)).toBe(now + 1000);
    expect(getSkewedTokenCacheTtlMs(expiresAt, now)).toBe(1000);
  });

  /** The floor exists to keep a short-but-real credential usable, not to revive a dead one: a
   *  provider that declares an elapsed expiry must not have it stamped into the future. */
  it('leaves an already-elapsed expiry elapsed', () => {
    expect(getSkewedTokenExpiresAtMs(now - 60_000, now)).toBe(now - 60_000);
    expect(getSkewedTokenExpiresAtMs(now, now)).toBe(now);
    expect(getSkewedTokenCacheTtlMs(now - 60_000, now)).toBe(1);
    expect(getSkewedTokenCacheTtlMs(now, now)).toBe(1);
  });
});

describe('hasUsableTokenExpiry', () => {
  const now = 1_700_000_000_000;
  const bufferMs = OPENID_EXPIRY_BUFFER_SECONDS * 1000;

  it('requires the credential to outlive the trip downstream', () => {
    expect(hasUsableTokenExpiry(now + bufferMs + 1, now)).toBe(true);
    expect(hasUsableTokenExpiry(now + bufferMs, now)).toBe(false);
    expect(hasUsableTokenExpiry(now + bufferMs - 1, now)).toBe(false);
  });

  it('rejects a missing or unusable expiry rather than assuming it is fresh', () => {
    expect(hasUsableTokenExpiry(null, now)).toBe(false);
    expect(hasUsableTokenExpiry(undefined, now)).toBe(false);
    expect(hasUsableTokenExpiry(NaN, now)).toBe(false);
  });
});
