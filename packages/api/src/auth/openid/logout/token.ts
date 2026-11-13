import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import type { Algorithm, JwtPayload, VerifyErrors } from 'jsonwebtoken';
import type { ProviderSessionRef } from 'librechat-data-provider';
import { isOpenIdIssuerMatch, resolveProviderSessionIssuer } from '~/auth/openid';

/** Per OIDC Back-Channel Logout 1.0 §2.6; the `events` member that marks a logout token. */
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/** Resolves the verification key for a logout token's `kid`; any rejection is treated as a
 *  temporary failure, since a just-rotated IdP key can look identical to a forged one. */
export type LogoutTokenKeyResolver = (kid: string | undefined) => Promise<string | Buffer>;

export interface ValidateLogoutTokenOptions {
  /** Normalized expected issuer; compared against the token's own normalized `iss`. */
  issuer: string;
  clientId: string;
  algorithms: string[];
  clockToleranceSec: number;
  maxTokenAgeSec: number;
  resolveKey: LogoutTokenKeyResolver;
  now?: () => Date;
}

export type LogoutTokenValidationResult =
  | { ok: true; ref: ProviderSessionRef; subject?: string }
  | { ok: false; code: 'INVALID'; reason: string }
  | { ok: false; code: 'TEMPORARY'; reason: string };

function invalid(reason: string): LogoutTokenValidationResult {
  return { ok: false, code: 'INVALID', reason };
}

function temporary(reason: string): LogoutTokenValidationResult {
  return { ok: false, code: 'TEMPORARY', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBackchannelLogoutEvent(events: unknown): boolean {
  return isRecord(events) && isRecord(events[BACKCHANNEL_LOGOUT_EVENT]);
}

function audienceIncludes(aud: unknown, clientId: string): boolean {
  return Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
}

function verifySignature(
  token: string,
  key: string | Buffer,
  algorithms: string[],
): Promise<JwtPayload | null> {
  return new Promise((resolve) => {
    jwt.verify(
      token,
      key,
      { algorithms: algorithms as Algorithm[], ignoreExpiration: true, ignoreNotBefore: true },
      (err: VerifyErrors | null, payload: JwtPayload | string | undefined) => {
        if (err || payload == null || typeof payload === 'string') {
          resolve(null);
          return;
        }
        resolve(payload);
      },
    );
  });
}

/** Validates a back-channel logout token per OIDC Back-Channel Logout 1.0 §2.6, deviating only in
 *  requiring a non-empty `sid`, since a token without one would end every session for its subject. */
export async function validateLogoutToken(
  token: string,
  options: ValidateLogoutTokenOptions,
): Promise<LogoutTokenValidationResult> {
  const now = options.now?.() ?? new Date();

  const decoded = jwt.decode(token, { complete: true });
  if (decoded == null || typeof decoded === 'string') {
    return invalid('malformed');
  }

  const alg = decoded.header.alg;
  if (typeof alg !== 'string' || !options.algorithms.includes(alg)) {
    return invalid('alg_not_permitted');
  }

  const kid = typeof decoded.header.kid === 'string' ? decoded.header.kid : undefined;

  let key: string | Buffer;
  try {
    key = await options.resolveKey(kid);
  } catch (error) {
    /** The IdP's JWKS was reachable and refetched, but has no key for this `kid`: the token
     *  was not signed by this IdP, not a transient lookup failure. */
    if (error instanceof jwksRsa.SigningKeyNotFoundError) {
      return invalid('key_not_found');
    }
    return temporary('key_unavailable');
  }

  const payload = await verifySignature(token, key, options.algorithms);
  if (payload == null) {
    return invalid('signature_invalid');
  }

  if (payload.nonce !== undefined) {
    return invalid('nonce_present');
  }

  const sid = payload.sid;
  if (typeof sid !== 'string' || sid.length === 0) {
    return invalid('missing_sid');
  }

  if (!hasBackchannelLogoutEvent(payload.events)) {
    return invalid('missing_backchannel_event');
  }

  if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
    return invalid('missing_jti');
  }

  if (typeof payload.iat !== 'number') {
    return invalid('missing_iat');
  }
  const ageSec = now.getTime() / 1000 - payload.iat;
  if (ageSec > options.maxTokenAgeSec + options.clockToleranceSec) {
    return invalid('stale_iat');
  }
  if (-ageSec > options.clockToleranceSec) {
    return invalid('iat_in_future');
  }

  if (
    typeof payload.exp === 'number' &&
    payload.exp + options.clockToleranceSec < now.getTime() / 1000
  ) {
    return invalid('expired_claim');
  }

  if (
    typeof payload.nbf === 'number' &&
    payload.nbf - options.clockToleranceSec > now.getTime() / 1000
  ) {
    return invalid('not_yet_valid');
  }

  const tokenIssuer = typeof payload.iss === 'string' ? payload.iss : undefined;
  if (!isOpenIdIssuerMatch(options.issuer, tokenIssuer)) {
    return invalid('issuer_mismatch');
  }

  if (!audienceIncludes(payload.aud, options.clientId)) {
    return invalid('audience_mismatch');
  }

  const subject =
    typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined;

  /** `isOpenIdIssuerMatch` above already confirmed a match, so this always resolves to the
   *  token's concrete issuer, scoping the reference to the tenant the logout actually names. */
  const issuer = resolveProviderSessionIssuer(options.issuer, tokenIssuer) ?? options.issuer;

  return { ok: true, ref: { issuer, clientId: options.clientId, sid }, subject };
}
