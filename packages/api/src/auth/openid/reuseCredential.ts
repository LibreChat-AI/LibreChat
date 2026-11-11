import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import type { TokenIssuance, TokenRetirementSignals } from '../twoFactor';
import type { SessionOpenIDTokens } from './types';
import { isTokenRetired } from '../twoFactor';

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

export interface OpenIDSessionRetirementInput {
  parsedCookies: { openid_user_id?: string };
  sessionTokens?: Pick<SessionOpenIDTokens, 'appUserId' | 'lastRefreshedAt'>;
  user: TokenRetirementSignals & { _id: { toString(): string } };
  jwtRefreshSecret: string | undefined;
  /** Binds the identity cookie to the refresh token a recovery path is about to spend. */
  refreshToken?: string;
}

/**
 * Whether the OpenID session a refresh would extend was established before an account event
 * that retires it.
 *
 * `openIdJwtStrategy` refuses OpenID bearers issued before a password reset or an enrollment, but
 * a refresh-token grant mints a fresh one, so honouring the grant would hand back what the
 * strategy just refused. The session is dated by the signed identity cookie, which is reissued
 * with every response that publishes the session, and otherwise by the server-side session's last
 * rotation. A session that carries neither for this user cannot be dated and, as with bearers, is
 * retired once any cutoff is set.
 */
export function isOpenIDSessionRetired({
  parsedCookies,
  sessionTokens,
  user,
  jwtRefreshSecret,
  refreshToken,
}: OpenIDSessionRetirementInput): boolean {
  const userId = user._id.toString();
  const credential = getValidOpenIDReuseCredential(parsedCookies, jwtRefreshSecret, refreshToken);
  if (credential?.userId === userId) {
    return isTokenRetired(credential, user);
  }
  const lastRefreshedAt = sessionTokens?.lastRefreshedAt;
  if (sessionTokens?.appUserId === userId && typeof lastRefreshedAt === 'number') {
    return isTokenRetired({ issuedAtMs: lastRefreshedAt }, user);
  }
  return isTokenRetired({}, user);
}
