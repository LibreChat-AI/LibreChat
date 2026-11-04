import { jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
export const BACKCHANNEL_LOGOUT_CLOCK_TOLERANCE_SECONDS = 5;

export type BackchannelLogoutTokenCode =
  | 'malformed'
  | 'invalid_signature'
  | 'disallowed_algorithm'
  | 'invalid_issuer'
  | 'invalid_audience'
  | 'expired'
  | 'iat_too_old'
  | 'missing_jti'
  | 'missing_subject'
  | 'missing_events'
  | 'unexpected_nonce';

export interface BackchannelLogoutToken {
  issuer: string;
  clientId: string;
  subject: string;
  sid?: string;
  jti: string;
  /** Epoch seconds. */
  iat: number;
}

export type BackchannelLogoutTokenResult =
  | { ok: true; token: BackchannelLogoutToken }
  | { ok: false; code: BackchannelLogoutTokenCode };

export interface BackchannelLogoutVerifierConfig {
  issuer: string;
  clientId: string;
  algorithms: string[];
  /** Oldest `iat` a token may carry, in seconds. */
  maxAgeSeconds: number;
}

export interface BackchannelLogoutVerifierDeps extends BackchannelLogoutVerifierConfig {
  getKey: JWTVerifyGetKey;
  now?: () => Date;
}

export type BackchannelLogoutVerifier = (token: string) => Promise<BackchannelLogoutTokenResult>;

function hasJoseErrorCode(error: unknown): error is { code: string; claim?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** Codes jose raises for a token that was read and rejected on its merits; anything else (JWKS
 *  fetch/timeout, network errors) is operational and the caller rethrows instead of mapping it. */
const TOKEN_VALIDATION_JOSE_CODES = new Set([
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JWT_INVALID',
]);

/** `iat` surfaces as `ERR_JWT_EXPIRED`/`ERR_JWT_CLAIM_VALIDATION_FAILED` depending on which check
 *  in jose's claim validator fails first. Rethrows operational codes (see the set above). */
function mapVerificationError(error: unknown): BackchannelLogoutTokenCode {
  if (!hasJoseErrorCode(error)) {
    return 'malformed';
  }
  if (!TOKEN_VALIDATION_JOSE_CODES.has(error.code)) {
    throw error;
  }
  switch (error.code) {
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return 'invalid_signature';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'disallowed_algorithm';
    case 'ERR_JWT_EXPIRED':
      return error.claim === 'iat' ? 'iat_too_old' : 'expired';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      switch (error.claim) {
        case 'iss':
          return 'invalid_issuer';
        case 'aud':
          return 'invalid_audience';
        case 'jti':
          return 'missing_jti';
        case 'exp':
          return 'expired';
        case 'iat':
          return 'iat_too_old';
        default:
          return 'malformed';
      }
    default:
      return 'malformed';
  }
}

function hasBackchannelLogoutEvent(events: unknown): boolean {
  if (typeof events !== 'object' || events === null || Array.isArray(events)) {
    return false;
  }
  const entry = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry);
}

/** Builds a reusable verifier bound to one issuer's key resolver; never logs the token it checks. */
export function createBackchannelLogoutVerifier(
  deps: BackchannelLogoutVerifierDeps,
): BackchannelLogoutVerifier {
  const { getKey, issuer, clientId, algorithms, maxAgeSeconds, now = () => new Date() } = deps;

  return async function verifyBackchannelLogoutToken(
    token: string,
  ): Promise<BackchannelLogoutTokenResult> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, getKey, {
        issuer,
        audience: clientId,
        algorithms,
        maxTokenAge: maxAgeSeconds,
        requiredClaims: ['exp', 'jti'],
        currentDate: now(),
        clockTolerance: BACKCHANNEL_LOGOUT_CLOCK_TOLERANCE_SECONDS,
      });
      payload = result.payload;
    } catch (error) {
      return { ok: false, code: mapVerificationError(error) };
    }

    if (payload.nonce !== undefined) {
      return { ok: false, code: 'unexpected_nonce' };
    }
    const subject = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!subject) {
      return { ok: false, code: 'missing_subject' };
    }
    if (!hasBackchannelLogoutEvent(payload.events)) {
      return { ok: false, code: 'missing_events' };
    }
    if (typeof payload.jti !== 'string' || payload.jti === '') {
      return { ok: false, code: 'missing_jti' };
    }

    const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
    return {
      ok: true,
      token: {
        issuer,
        clientId,
        subject,
        ...(sid != null && { sid }),
        jti: payload.jti,
        iat: payload.iat as number,
      },
    };
  };
}
