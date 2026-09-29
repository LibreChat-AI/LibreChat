import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Time } from 'librechat-data-provider';
import type { Request, Response, NextFunction } from 'express';
import { mcpConfig } from '~/mcp/mcpConfig';
import { isEnabled } from '~/utils/common';

export const OAUTH_CSRF_COOKIE = 'oauth_csrf';
export const OAUTH_CSRF_MAX_AGE: number = 10 * 60 * 1000;

export const OAUTH_SESSION_COOKIE = 'oauth_session';
export const OAUTH_SESSION_COOKIE_PATH = '/api';

/**
 * TTL (ms) of the `FLOWS` Keyv namespace, `Time.ONE_MINUTE * 10` as registered in
 * `api/cache/getLogStores.js`. The action OAuth flow stores its state in that
 * namespace and its callback (`api/server/routes/actions.js`) applies no staleness
 * check — it requires only that the flow state still exist — so this namespace TTL
 * is the entire window in which an action callback can still succeed. It uses none
 * of the MCP variables, so it is a second, independent term of the flow window.
 * Mirrored here because that TTL lives in the sibling `api` workspace, which
 * `packages/api` does not import from; keep the two in step.
 */
export const FLOWS_TTL: number = Time.ONE_MINUTE * 10;

/**
 * The `oauth_session` cookie's lifetime, the widest window in which either OAuth
 * callback can still resolve its flow: `max(mcpConfig.OAUTH_FLOW_TTL, FLOWS_TTL)`.
 *
 * `mcpConfig.OAUTH_FLOW_TTL` is the codebase's own bound on how long an MCP
 * callback can still find its flow — `max(MCP_OAUTH_FLOW_TTL ?? 15min,
 * MCP_OAUTH_HANDLING_TIMEOUT + 60s grace)` — and already tracks both MCP
 * variables. `MCP_OAUTH_HANDLING_TIMEOUT` alone would under-shoot: at default
 * configuration the flow TTL is 15 minutes while the handling timeout plus grace
 * is 11. `FLOWS_TTL` is the second term because the action flow derives its window
 * from the namespace TTL alone; without it a low `MCP_OAUTH_HANDLING_TIMEOUT` would
 * expire the cookie while action flows are still live.
 *
 * The lifetime is not extended past this window: a callback arriving after it is
 * refused by the application regardless of any cookie, so a longer lifetime admits
 * only requests that will be refused.
 */
export function getOAuthSessionMaxAge(): number {
  return Math.max(mcpConfig.OAUTH_FLOW_TTL, FLOWS_TTL);
}

/**
 * Fixed HKDF info label for the `oauth_session` signing key (Session_Cookie_Key).
 * The label carries the purpose separation between this key and the input secret:
 * it is what makes the derived key usable for the `oauth_session` cookie and
 * nothing else. Versioned (`.v1`) so a future rotation of the derivation can be
 * introduced without silently colliding with keys already in the field.
 */
export const OAUTH_SESSION_KEY_INFO = 'librechat.oauth_session.v1';

/**
 * Derives the Session_Cookie_Key that signs and verifies the `oauth_session`
 * cookie.
 *
 * The key is derived with HKDF-SHA256 from `JWT_REFRESH_SECRET` under the fixed
 * info label `librechat.oauth_session.v1`. Deriving from the refresh secret
 * means the gate container only needs `JWT_REFRESH_SECRET` (which it already
 * holds for refresh-token verification) — `JWT_SECRET` stays confined to the
 * API container and does not need to be distributed to the gate.
 *
 * The derivation is one-way: HKDF-SHA256 is a pseudorandom function, so a party
 * holding the derived key (the Auth_Gate) cannot recover `JWT_REFRESH_SECRET`
 * and gains no refresh-token minting ability from it.
 *
 * INVARIANT — this key signs exactly ONE token type (`oauth_session`). The info
 * label is what carries the purpose separation, in place of a `typ`/`aud`
 * claim. Signing a second token type with this key reintroduces the token
 * substitution surface that key separation closes: two HS256 tokens sharing a
 * key and a `{ id, exp }` shape become structurally interchangeable, and a
 * `typ` claim would then be required to tell them apart. Do not reuse this key
 * for anything other than the `oauth_session` cookie — derive a new key under a
 * new info label instead.
 */
export function deriveOAuthSessionKey(): Buffer {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET is required to derive the OAuth session cookie key');
  }
  /** Empty salt keeps the derivation deterministic across both containers and the
   *  gate; the input secret already carries the entropy and the info label
   *  provides the domain separation. `hkdfSync` returns an `ArrayBuffer`. */
  const derived = crypto.hkdfSync('sha256', secret, Buffer.alloc(0), OAUTH_SESSION_KEY_INFO, 32);
  return Buffer.from(derived);
}

/**
 * Determines if secure cookies should be used.
 * SESSION_COOKIE_SECURE=true/false explicitly overrides the environment heuristic.
 * Returns `true` in production unless DOMAIN_SERVER uses a localhost-style hostname.
 * This allows cookies to work on localhost during local development
 * even when `NODE_ENV=production` (common in Docker Compose setups).
 */
export function shouldUseSecureCookie(): boolean {
  const secureOverride = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (secureOverride === 'true' || secureOverride === 'false') {
    return isEnabled(secureOverride);
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const domainServer = process.env.DOMAIN_SERVER || '';

  let hostname = '';
  if (domainServer) {
    try {
      const normalized = /^https?:\/\//i.test(domainServer)
        ? domainServer
        : `http://${domainServer}`;
      const url = new URL(normalized);
      hostname = (url.hostname || '').toLowerCase();
    } catch {
      hostname = domainServer.toLowerCase();
    }
  }

  const isLocalhost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost');

  return isProduction && !isLocalhost;
}

export const REFRESH_TOKEN_COOKIE = 'refreshToken';
export const TOKEN_PROVIDER_COOKIE = 'token_provider';
export const OPENID_USER_ID_COOKIE = 'openid_user_id';

/**
 * Writes the IdP refresh token to the `refreshToken` cookie. Single source of
 * truth for the cookie's options so the login/refresh path
 * (`setOpenIDAuthTokens`) and the inline OBO refresh path (`performIdpRefresh`)
 * stay byte-for-byte in sync. The cookie outlives the (shorter) express-session
 * cookie and is the fallback `refreshController` reads when the session copy is
 * gone, so a rotated refresh token must land here too — otherwise a later
 * session loss replays an invalidated token and signs the user out.
 */
export function setRefreshTokenCookie(res: Response, refreshToken: string, expires: Date): void {
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    expires,
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'strict',
  });
}

export interface OpenIDMarkerCookieOptions {
  userId?: string | null;
  expires: Date;
  refreshExpiryMs: number;
  reuseTokens?: boolean;
  /** Binds the marker to the refresh token it was issued alongside. */
  refreshToken?: string | null;
}

export function setOpenIDMarkerCookies(
  res: Response,
  {
    userId,
    expires,
    refreshExpiryMs,
    reuseTokens = isEnabled(process.env.OPENID_REUSE_TOKENS),
    refreshToken,
  }: OpenIDMarkerCookieOptions,
): void {
  const cookieOptions = {
    expires,
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'strict' as const,
  };

  res.cookie(TOKEN_PROVIDER_COOKIE, 'openid', cookieOptions);

  if (!userId || !reuseTokens) {
    return;
  }

  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    throw new Error('JWT_REFRESH_SECRET is required for OpenID marker cookies');
  }

  const refreshExpirySeconds = Math.floor(refreshExpiryMs / 1000);
  if (!Number.isFinite(refreshExpirySeconds) || refreshExpirySeconds <= 0) {
    throw new Error('refreshExpiryMs must be a positive duration for OpenID marker cookies');
  }

  /** Bind the marker to the durable refresh-token session it was issued with, so a
   *  marker lifted from one session cannot stand in for another's. */
  const refreshTokenHash = refreshToken
    ? crypto.createHash('sha256').update(refreshToken).digest('base64url')
    : undefined;
  const signedUserId = jwt.sign(
    refreshTokenHash ? { id: userId, refreshTokenHash } : { id: userId },
    secret,
    { expiresIn: refreshExpirySeconds },
  );
  res.cookie(OPENID_USER_ID_COOKIE, signedUserId, cookieOptions);
}

/** Generates an HMAC-based token for OAuth CSRF protection */
export function generateOAuthCsrfToken(flowId: string, secret?: string): string {
  const key = secret || process.env.JWT_SECRET;
  if (!key) {
    throw new Error('JWT_SECRET is required for OAuth CSRF token generation');
  }
  return crypto.createHmac('sha256', key).update(flowId).digest('hex').slice(0, 32);
}

/** Sets a SameSite=Lax CSRF cookie bound to a specific OAuth flow */
export function setOAuthCsrfCookie(res: Response, flowId: string, cookiePath: string): void {
  res.cookie(OAUTH_CSRF_COOKIE, generateOAuthCsrfToken(flowId), {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    maxAge: OAUTH_CSRF_MAX_AGE,
    path: cookiePath,
  });
}

/**
 * Validates the per-flow CSRF cookie against the expected HMAC.
 * Uses timing-safe comparison and always clears the cookie to prevent replay.
 */
export function validateOAuthCsrf(
  req: Request,
  res: Response,
  flowId: string,
  cookiePath: string,
): boolean {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[OAUTH_CSRF_COOKIE];
  res.clearCookie(OAUTH_CSRF_COOKIE, { path: cookiePath });
  if (!cookie) {
    return false;
  }
  const expected = generateOAuthCsrfToken(flowId);
  if (cookie.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(expected));
}

/**
 * Express middleware that sets the OAuth session cookie after JWT authentication.
 * Chain after requireJwtAuth on routes that precede an OAuth redirect (e.g., reinitialize, bind).
 *
 * The cookie is written unconditionally whenever a user id is present, replacing
 * any cookie already there rather than skipping when one exists. Two things follow:
 * each flow starts with a full lifetime (the previous "only if absent" form let a
 * near-expired cookie carry a fresh flow), and the cookie always describes the
 * current user (an account switch in the same browser overwrites the prior user's
 * cookie rather than leaving it standing). `setOAuthSessionCookie` mints an `exp`
 * from the current time, so the overwrite is what refreshes the lifetime.
 */
export function setOAuthSession(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { id?: string } }).user;
  if (user?.id) {
    setOAuthSessionCookie(res, user.id);
  }
  next();
}

/**
 * Sets a SameSite=Lax session cookie that binds the browser to the authenticated
 * userId.
 *
 * The cookie carries a signed HS256 token of the form `{ id, exp }`, where `id`
 * is the user id and `exp` is the expiry. This self-describing form is what lets
 * the Auth_Gate verify the cookie without knowing the subject or the flow: a bare
 * keyed digest over the subject cannot be verified without already knowing the
 * subject, and the subject does not appear in a callback request. The token is
 * signed with the Session_Cookie_Key (derived one-way from `JWT_REFRESH_SECRET`),
 * never with `JWT_SECRET` or `JWT_REFRESH_SECRET` directly.
 *
 * The `exp` claim and the cookie `maxAge` are set from the same duration so the
 * browser (on `maxAge`) and the gate (on `exp`) agree on the lifetime. That
 * duration is the flow window (`getOAuthSessionMaxAge()`), and the two bounds are
 * set exactly equal — not approximately. That is safe only because the two bounds
 * are enforced by different parties on different clocks (the browser on `maxAge`,
 * the gate on `exp`) and the gate carries a clock-skew allowance, which makes it
 * the more lenient of the two at the boundary; without that allowance the rule
 * would have to be inner (`exp`) >= outer (`maxAge`).
 */
export function setOAuthSessionCookie(res: Response, userId: string): void {
  const maxAge = getOAuthSessionMaxAge();
  const token = jwt.sign({ id: userId }, deriveOAuthSessionKey(), {
    algorithm: 'HS256',
    expiresIn: Math.floor(maxAge / 1000),
  });
  res.cookie(OAUTH_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    maxAge,
    path: OAUTH_SESSION_COOKIE_PATH,
  });
}

/**
 * Validates the session cookie by verifying its HS256 signature against the
 * Session_Cookie_Key, rejecting an absent or expired `exp`, and comparing the
 * `id` claim against the caller-supplied user id.
 *
 * Verifying a signed token rather than recomputing a digest is what makes the
 * cookie gate-verifiable, but this application-side check still binds the cookie
 * to a specific user by comparing its `id` claim against the flow's `userId`.
 * The signature is verified only against the derived key (`algorithms: ['HS256']`
 * pins the algorithm), so a value signed with `JWT_SECRET` or `JWT_REFRESH_SECRET`
 * is not accepted here.
 */
export function validateOAuthSession(req: Request, userId: string): boolean {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[OAUTH_SESSION_COOKIE];
  if (!cookie) {
    return false;
  }
  try {
    const payload = jwt.verify(cookie, deriveOAuthSessionKey(), {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    /** `jwt.verify` rejects an expired token, but a token minted with no `exp`
     *  claim verifies successfully — reject that explicitly so an unbounded
     *  cookie is never treated as valid. */
    if (typeof payload.exp !== 'number') {
      return false;
    }
    return payload.id === userId;
  } catch {
    return false;
  }
}
