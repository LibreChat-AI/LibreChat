import jwt from 'jsonwebtoken';
import { SystemRoles } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { StoredTwoFactorAccount, TokenIssuance } from './twoFactor';
import type { CloudFrontCookieScope } from '~/cdn/cloudfront-cookies';
import { isTokenRetired, isTwoFactorEnrollmentRequired } from './twoFactor';
import { clearEnrollmentViewer } from './gates';
import { isEnabled } from '~/utils';

type ShareUser = Pick<
  StoredTwoFactorAccount,
  | '_id'
  | 'id'
  | 'provider'
  | 'role'
  | 'tenantId'
  | 'orgId'
  | 'storageRegion'
  | 'twoFactorEnabled'
  | 'twoFactorEnrolledAt'
  | 'credentialsChangedAt'
>;
type ShareRequest = Request & {
  user?: ShareUser;
  authStrategy?: string;
  session?: { openidTokens?: { refreshToken?: string } };
};
type VerifiedUser = TokenIssuance & { userId: string };

export interface ShareFileAuthDependencies {
  parseCookie: (header: string) => Record<string, string>;
  getUserById: (userId: string, projection: string) => Promise<ShareUser | null>;
  findSession: (filter: { userId: string; refreshToken: string }) => Promise<object | null>;
  runAsSystem: <T>(fn: () => Promise<T>) => Promise<T>;
  clearCloudFrontCookies: (res: Response, scope: CloudFrontCookieScope) => void;
  warn: (message: string, detail?: string) => void;
  enrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
  tokenRetired?: typeof isTokenRetired;
  enabled?: typeof isEnabled;
}

export function createOptionalShareFileAuth(deps: ShareFileAuthDependencies) {
  const verifySignedUser = (token: string | undefined): VerifiedUser | null => {
    try {
      const payload = jwt.verify(token ?? '', process.env.JWT_REFRESH_SECRET ?? '');
      if (typeof payload !== 'object' || typeof payload.id !== 'string') {
        return null;
      }
      return {
        userId: payload.id,
        issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
        issuedAtMs: typeof payload.issuedAtMs === 'number' ? payload.issuedAtMs : undefined,
      };
    } catch {
      return null;
    }
  };

  const getRefreshTokenUser = async (token: string): Promise<VerifiedUser | null> => {
    const verified = verifySignedUser(token);
    if (!verified) {
      return null;
    }
    const session = await deps.runAsSystem(() =>
      deps.findSession({ userId: verified.userId, refreshToken: token }),
    );
    return session ? verified : null;
  };

  const getOpenIdUser = (
    parsed: Record<string, string>,
    req: ShareRequest,
  ): VerifiedUser | null => {
    if (
      parsed.token_provider !== 'openid' ||
      !(deps.enabled ?? isEnabled)(process.env.OPENID_REUSE_TOKENS)
    ) {
      return null;
    }
    const sessionRefreshToken = req.session?.openidTokens?.refreshToken;
    if (!parsed.refreshToken || parsed.refreshToken !== sessionRefreshToken) {
      return null;
    }
    return verifySignedUser(parsed.openid_user_id);
  };

  const clearCookies = (res: Response, user: ShareUser): void => {
    deps.clearCloudFrontCookies(res, {
      userId: user.id?.toString() ?? user._id?.toString(),
      tenantId: user.tenantId ?? user.orgId,
      storageRegion: user.storageRegion,
    });
  };

  return async (req: ShareRequest, res: Response, next: NextFunction): Promise<void> => {
    if (req.user) {
      clearEnrollmentViewer(req, res, req.user, deps);
      next();
      return;
    }

    try {
      const cookieHeader = req.headers.cookie;
      if (!cookieHeader) {
        next();
        return;
      }
      const parsed = deps.parseCookie(cookieHeader);
      const verified =
        getOpenIdUser(parsed, req) ||
        (parsed.refreshToken ? await getRefreshTokenUser(parsed.refreshToken) : null);
      if (!verified) {
        next();
        return;
      }

      // This read precedes the share tenant, so it must use system context.
      const user = await deps.runAsSystem(() =>
        deps.getUserById(verified.userId, '-password -__v -totpSecret -backupCodes'),
      );
      if (!user) {
        next();
        return;
      }
      if (
        (deps.enrollmentRequired ?? isTwoFactorEnrollmentRequired)(user) ||
        (deps.tokenRetired ?? isTokenRetired)(verified, user)
      ) {
        clearCookies(res, user);
        next();
        return;
      }
      user.id = user._id.toString();
      if (!user.role) {
        user.role = SystemRoles.USER;
      }
      req.user = user;
    } catch (error) {
      deps.warn(
        '[optionalShareFileAuth] cookie auth failed:',
        error instanceof Error ? error.message : undefined,
      );
    }
    next();
  };
}
