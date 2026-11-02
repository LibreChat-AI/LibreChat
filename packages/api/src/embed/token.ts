import jwt from 'jsonwebtoken';
import type { EmbedApp } from './apps';

/** Allowed drift between the host's clock and this server's when checking `iat` and `exp`. */
const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_SUBJECT_LENGTH = 256;
const MAX_JTI_LENGTH = 128;
const MAX_NAME_LENGTH = 128;

/** The host user a verified embed token vouches for. */
export interface EmbedIdentity {
  /** The host's stable user id (`sub`). */
  subject: string;
  /** Display name, when the host sent one. */
  name?: string;
  /** Unique token id, consumed once. */
  jti: string;
  /** Token expiry, ms since epoch. */
  expiresAt: number;
}

export type EmbedTokenErrorCode = 'invalid_token' | 'token_lifetime_too_long';

export type EmbedTokenResult =
  | { ok: true; value: EmbedIdentity }
  | { ok: false; error: { code: EmbedTokenErrorCode } };

interface EmbedTokenClaims {
  sub?: unknown;
  jti?: unknown;
  iat?: unknown;
  exp?: unknown;
  name?: unknown;
}

const isNonEmptyString = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

/**
 * Verifies a token the host backend signed for one of its users. The token must be HS256 with
 * the app's secret, name the app as its audience, and carry `sub`, `jti`, `iat` and `exp`, with
 * a lifetime no longer than the app's `maxTokenAgeSeconds`. Verification failures are reported
 * by code only, so library messages never reach the client.
 */
export function verifyEmbedToken(token: string, app: EmbedApp): EmbedTokenResult {
  let claims: EmbedTokenClaims;
  try {
    claims = jwt.verify(token, app.secret, {
      algorithms: ['HS256'],
      audience: app.id,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }) as EmbedTokenClaims;
  } catch {
    return { ok: false, error: { code: 'invalid_token' } };
  }

  const { sub, jti, iat, exp, name } = claims;
  if (
    !isNonEmptyString(sub, MAX_SUBJECT_LENGTH) ||
    !isNonEmptyString(jti, MAX_JTI_LENGTH) ||
    typeof iat !== 'number' ||
    typeof exp !== 'number'
  ) {
    return { ok: false, error: { code: 'invalid_token' } };
  }

  /** Bounding `exp` by the clock as well stops a token pre-signed with a future `iat` from
   * staying valid long after it was minted. */
  const nowSeconds = Date.now() / 1000;
  if (
    exp - iat > app.maxTokenAgeSeconds ||
    exp - nowSeconds > app.maxTokenAgeSeconds + CLOCK_TOLERANCE_SECONDS
  ) {
    return { ok: false, error: { code: 'token_lifetime_too_long' } };
  }

  return {
    ok: true,
    value: {
      subject: sub,
      name:
        typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME_LENGTH) : undefined,
      jti,
      expiresAt: exp * 1000,
    },
  };
}
