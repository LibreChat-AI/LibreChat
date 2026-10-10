import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import type { TokenIssuance } from '../twoFactor';

export interface OpenIDReuseCredential extends TokenIssuance {
  userId: string;
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
      issuedAt: payload.iat,
      issuedAtMs: typeof payload.issuedAtMs === 'number' ? payload.issuedAtMs : undefined,
    };
  } catch {
    return null;
  }
}
