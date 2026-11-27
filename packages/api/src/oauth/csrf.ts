import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { SESSION_HINT_COOKIE, themeOwnerKey, formatSessionHint } from 'librechat-data-provider';
import type { Request, Response, NextFunction } from 'express';
import { getOAuthCallbackUrl } from './url';
import { isEnabled } from '~/utils/common';

export const OAUTH_CSRF_COOKIE = 'oauth_csrf';
export const OAUTH_CSRF_MAX_AGE: number = 10 * 60 * 1000;

export const OAUTH_SESSION_COOKIE = 'oauth_session';
export const OAUTH_SESSION_MAX_AGE: number = 24 * 60 * 60 * 1000;
export const OAUTH_SESSION_COOKIE_PATH = '/api';

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

export interface SessionHintOwner {
  userId?: string | { toString(): string } | null;
  tenantId?: string | null;
}

/**
 * Names the session's owner and expiry where the page can read them before the app runs, so a
 * replay of something the owner cached skips a session that ended or belongs to someone else.
 * A session with no known user clears it rather than leaving a previous owner's hint behind.
 */
export function setSessionHintCookie(
  res: Response,
  expires: Date,
  { userId, tenantId }: SessionHintOwner,
): void {
  if (!userId) {
    res.clearCookie(SESSION_HINT_COOKIE);
    return;
  }
  const owner = themeOwnerKey(userId.toString(), tenantId);
  res.cookie(SESSION_HINT_COOKIE, formatSessionHint({ expires: expires.getTime(), owner }), {
    expires,
    secure: shouldUseSecureCookie(),
    sameSite: 'strict',
  });
}

export interface LocalSessionCookieOptions extends SessionHintOwner {
  refreshToken: string;
  expires: Date;
}

/**
 * Issues the cookies of a LibreChat-managed session together: the refresh token, its provider
 * marker and the readable hint naming the owner, so all three share one expiry and owner.
 */
export function setLocalSessionCookies(
  res: Response,
  { refreshToken, expires, userId, tenantId }: LocalSessionCookieOptions,
): void {
  setRefreshTokenCookie(res, refreshToken, expires);
  res.cookie(TOKEN_PROVIDER_COOKIE, 'librechat', {
    expires,
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'strict',
  });
  setSessionHintCookie(res, expires, { userId, tenantId });
}

/** Retires the readable session hint when a request proves there is no session to vouch for. */
export function clearSessionHintCookie(res: Response): void {
  res.clearCookie(SESSION_HINT_COOKIE);
}

export interface OpenIDMarkerCookieOptions {
  userId?: string | null;
  /** Names the session's owner in the readable session hint alongside `userId`. */
  tenantId?: string | null;
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
    tenantId,
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
  setSessionHintCookie(res, expires, { userId, tenantId });

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
    { id: userId, issuedAtMs: Date.now(), ...(refreshTokenHash ? { refreshTokenHash } : {}) },
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

/** Cookie paths must match the public callback URL, not a proxy-stripped request path. */
function getOAuthCookiePath(cookiePath: string): string {
  const domainServer = process.env.DOMAIN_SERVER;
  if (!domainServer) {
    return cookiePath;
  }
  try {
    return new URL(getOAuthCallbackUrl(domainServer, cookiePath)).pathname;
  } catch {
    return cookiePath;
  }
}

/** Sets a SameSite=Lax CSRF cookie bound to a specific OAuth flow. `maxAge` follows the flow's own
 *  approval window when it has one, so the cookie lives as long as the state it binds. */
export function setOAuthCsrfCookie(
  res: Response,
  flowId: string,
  cookiePath: string,
  maxAge: number = OAUTH_CSRF_MAX_AGE,
): void {
  res.cookie(OAUTH_CSRF_COOKIE, generateOAuthCsrfToken(flowId), {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    maxAge,
    path: getOAuthCookiePath(cookiePath),
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
  res.clearCookie(OAUTH_CSRF_COOKIE, { path: getOAuthCookiePath(cookiePath) });
  if (typeof cookie !== 'string' || !cookie) {
    return false;
  }
  const expected = generateOAuthCsrfToken(flowId);
  if (cookie.length !== expected.length) {
    return false;
  }
  const cookieBuffer = Buffer.from(cookie);
  const expectedBuffer = Buffer.from(expected);
  return (
    cookieBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(cookieBuffer, expectedBuffer)
  );
}

/**
 * Express middleware that sets the OAuth session cookie after JWT authentication.
 * Chain after requireJwtAuth on routes that precede an OAuth redirect (e.g., reinitialize, bind).
 */
export function setOAuthSession(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { id?: string } }).user;
  if (user?.id && !validateOAuthSession(req, user.id)) {
    setOAuthSessionCookie(res, user.id);
  }
  next();
}

/** Sets a SameSite=Lax session cookie that binds the browser to the authenticated userId */
export function setOAuthSessionCookie(res: Response, userId: string): void {
  res.cookie(OAUTH_SESSION_COOKIE, generateOAuthCsrfToken(userId), {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    maxAge: OAUTH_SESSION_MAX_AGE,
    path: getOAuthCookiePath(OAUTH_SESSION_COOKIE_PATH),
  });
}

/** Validates the session cookie against the expected userId using timing-safe comparison */
export function validateOAuthSession(req: Request, userId: string): boolean {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[OAUTH_SESSION_COOKIE];
  if (typeof cookie !== 'string' || !cookie) {
    return false;
  }
  const expected = generateOAuthCsrfToken(userId);
  if (cookie.length !== expected.length) {
    return false;
  }
  const cookieBuffer = Buffer.from(cookie);
  const expectedBuffer = Buffer.from(expected);
  return (
    cookieBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(cookieBuffer, expectedBuffer)
  );
}
