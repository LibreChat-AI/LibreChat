import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import type { SessionOpenIDTokens } from './types';
import type { TokenIssuance } from '../twoFactor';

export interface OpenIDReuseCredential extends TokenIssuance {
  userId: string;
  authGenerationId?: string;
  openidIssuer?: string;
  openidSubject?: string;
  tenantId?: string;
}

/** Verify the identity cookie and, when supplied, bind it to the source refresh token. */
export function getValidOpenIDReuseCredential(
  parsedCookies: { openid_user_id?: string },
  jwtRefreshSecret: string | undefined,
  refreshToken?: string,
): OpenIDReuseCredential | null {
  if (!parsedCookies.openid_user_id || !jwtRefreshSecret) {
    return null;
  }

  try {
    const payload = jwt.verify(parsedCookies.openid_user_id, jwtRefreshSecret);
    if (typeof payload === 'string' || typeof payload.id !== 'string') {
      return null;
    }
    if (refreshToken != null) {
      if (typeof payload.refreshTokenHash !== 'string') {
        return null;
      }
      const hash = createHash('sha256').update(refreshToken).digest('base64url');
      if (payload.refreshTokenHash !== hash) {
        return null;
      }
    }
    return {
      userId: payload.id,
      authGenerationId:
        typeof payload.authGenerationId === 'string' ? payload.authGenerationId : undefined,
      openidIssuer: typeof payload.openidIssuer === 'string' ? payload.openidIssuer : undefined,
      openidSubject: typeof payload.openidSubject === 'string' ? payload.openidSubject : undefined,
      tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : undefined,
      issuedAt: payload.iat,
      issuedAtMs: typeof payload.issuedAtMs === 'number' ? payload.issuedAtMs : undefined,
    };
  } catch {
    return null;
  }
}

/** Recover identity for a browser check without restoring an access token or ID token. */
export function getOpenIDCheckIdentity(
  cookies: { openid_user_id?: string; refreshToken?: string },
  secret: string | undefined,
): SessionOpenIDTokens | null {
  if (!cookies.refreshToken) return null;
  const identity = getValidOpenIDReuseCredential(cookies, secret, cookies.refreshToken);
  if (
    !identity?.userId ||
    !identity.authGenerationId ||
    !identity.openidIssuer ||
    !identity.openidSubject
  )
    return null;
  return {
    appUserId: identity.userId,
    authGenerationId: identity.authGenerationId,
    openidIssuer: identity.openidIssuer,
    openidSubject: identity.openidSubject,
    tenantId: identity.tenantId,
    refreshToken: cookies.refreshToken,
    browserRefreshToken: cookies.refreshToken,
  };
}
