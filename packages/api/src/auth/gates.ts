import jwt from 'jsonwebtoken';
import { runAsSystem } from '@librechat/data-schemas';
import { TWO_FACTOR_ENROLLMENT_REQUIRED_CODE } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { TokenIssuance, TokenRetirementSignals, TwoFactorAccount } from './twoFactor';
import type { CloudFrontCookieScope } from '~/cdn/cloudfront-cookies';
import {
  generateTwoFactorSetupToken,
  isTokenRetired,
  isTwoFactorEnrollmentRequired,
  TOKEN_RETIREMENT_FIELDS,
} from './twoFactor';

type AuthUser = Pick<
  TwoFactorAccount,
  '_id' | 'id' | 'provider' | 'tenantId' | 'orgId' | 'storageRegion' | 'twoFactorEnabled'
>;

type AuthRequest = Request & { user?: AuthUser; authStrategy?: string };

export interface TwoFactorGateDependencies {
  clearCloudFrontCookies: (res: Response, scope: CloudFrontCookieScope) => void;
  getUserById: (userId: string, projection: string) => Promise<TokenRetirementSignals | null>;
  warn: (message: string) => void;
  generateSetupToken?: typeof generateTwoFactorSetupToken;
  enrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
  tokenRetired?: typeof isTokenRetired;
}

export function clearEnrollmentViewer(
  req: AuthRequest,
  res: Response,
  user: AuthUser | null | undefined,
  deps: Pick<TwoFactorGateDependencies, 'clearCloudFrontCookies' | 'enrollmentRequired'>,
): boolean {
  if (!(deps.enrollmentRequired ?? isTwoFactorEnrollmentRequired)(user)) {
    return false;
  }
  deps.clearCloudFrontCookies(res, {
    userId: user?.id?.toString() ?? user?._id?.toString(),
    tenantId: user?.tenantId ?? user?.orgId,
    storageRegion: user?.storageRegion,
  });
  delete req.user;
  delete req.authStrategy;
  return true;
}

const normalizeRouteSegment = (value: string): string =>
  typeof value === 'string' ? value.toLowerCase().replace(/\/+$/, '') : '';

function isPolicyAllowlisted(req: Request): boolean {
  return (
    req.method === 'POST' &&
    normalizeRouteSegment(req.baseUrl) === '/api/auth' &&
    normalizeRouteSegment(req.path) === '/logout'
  );
}

function getAuthorizingCredential(req: Request): TokenIssuance {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const token = typeof value === 'string' ? value.replace(/^Bearer\s+/i, '') : '';
  const decoded = token ? jwt.decode(token) : null;
  const payload = decoded && typeof decoded === 'object' ? decoded : null;
  return {
    issuedAt: typeof payload?.iat === 'number' ? payload.iat : undefined,
    issuedAtMs: typeof payload?.issuedAtMs === 'number' ? payload.issuedAtMs : undefined,
  };
}

/** The cutoff read is deliberately after minting the setup token. */
export function createRequiredTwoFactorGate(deps: TwoFactorGateDependencies) {
  return (req: AuthRequest, res: Response, next: NextFunction, onAllowed: () => void): void => {
    if (
      !(deps.enrollmentRequired ?? isTwoFactorEnrollmentRequired)(req.user) ||
      isPolicyAllowlisted(req)
    ) {
      onAllowed();
      return;
    }

    void (async () => {
      const user = req.user;
      const userId = (user?.id?.toString() ?? user?._id?.toString()) as string;
      deps.clearCloudFrontCookies(res, {
        userId,
        tenantId: user?.tenantId ?? user?.orgId,
        storageRegion: user?.storageRegion,
      });
      const tempToken = (deps.generateSetupToken ?? generateTwoFactorSetupToken)(
        userId,
        process.env.JWT_SECRET as string,
      );
      /** Tenant context is established only after this gate, as the JWT strategy's own read is. */
      const retirement = await runAsSystem(() => deps.getUserById(userId, TOKEN_RETIREMENT_FIELDS));
      if ((deps.tokenRetired ?? isTokenRetired)(getAuthorizingCredential(req), retirement)) {
        deps.warn(
          `[requireJwtAuth] Password was reset while the request was in flight: userId=${userId}`,
        );
        res.status(401).json({ message: 'Unauthorized' });
        return;
      }
      res.status(403).json({
        code: TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
        twoFAPending: true,
        twoFASetupRequired: true,
        tempToken,
      });
    })().catch(next);
  };
}

export function continueAfterOptionalAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  user: AuthUser,
  strategy: string,
  tenantContextMiddleware: (req: Request, res: Response, next: NextFunction) => void,
  deps: Pick<TwoFactorGateDependencies, 'clearCloudFrontCookies' | 'enrollmentRequired'>,
): void {
  if (clearEnrollmentViewer(req, res, user, deps)) {
    next();
    return;
  }
  req.user = user;
  req.authStrategy = strategy;
  tenantContextMiddleware(req, res, next);
}

/** Keeps the strategy callback and its accepted-user path in the caller. */
export function continueAfterBearerRetirement(
  user: TokenRetirementSignals,
  issuance: TokenIssuance,
  kind: 'jwt' | 'openidJwt',
  subject: string | undefined,
  done: (error: null, user: false, info?: { message: string }) => void,
  warn: (message: string) => void,
  onAllowed: () => Promise<void> | void,
  tokenRetired: typeof isTokenRetired = isTokenRetired,
): Promise<void> | void {
  if (tokenRetired(issuance, user)) {
    const label = kind === 'jwt' ? 'jwtLogin] JwtStrategy' : 'openIdJwtLogin] openId JwtStrategy';
    warn(`[${label} => token predates enrollment or password reset: ${subject}`);
    done(
      null,
      false,
      kind === 'openidJwt' ? { message: 'Token predates enrollment or password reset' } : undefined,
    );
    return;
  }
  return onAllowed();
}
