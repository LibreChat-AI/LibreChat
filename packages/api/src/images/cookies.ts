import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { SystemRoles } from 'librechat-data-provider';
import type { Request, RequestHandler, Response } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import type { TokenIssuance, TwoFactorAccount, TwoFactorTokenCredential } from '~/auth/twoFactor';
import type { CloudFrontCookieScope } from '~/cdn/cloudfront-cookies';
import { isTokenRetired, isTwoFactorEnrollmentRequired } from '~/auth/twoFactor';
import { clearEnrollmentViewer } from '~/auth/gates';

export type CookieAuthResult =
  | { status: 'missing' | 'invalid' }
  | ({ status: 'authenticated' } & TwoFactorTokenCredential);

export interface CookieAuthenticationDeps {
  parseCookies(header: string): Record<string, string | undefined>;
  isOpenIdReuseEnabled(): boolean;
  getSecret(): string | undefined;
  findSession(query: { userId: string; refreshToken: string }): Promise<unknown | null>;
  asSystem<T>(work: () => Promise<T>): Promise<T>;
}

type CookieRequest = Pick<Request, 'headers'> & {
  session?: { openidTokens?: { refreshToken?: string } };
};
type VerifiedCookieIdentity = TokenIssuance & {
  status: 'verified';
  userId: string;
  /** Omitted only when the legacy OpenID cookie is bound to the active Express session. */
  refreshToken?: string;
};
type CookieIdentity =
  | Exclude<CookieAuthResult, { status: 'authenticated' }>
  | VerifiedCookieIdentity;

/** Local verification completes before any session or user database access. */
function verifyCookieIdentity(req: CookieRequest, deps: CookieAuthenticationDeps): CookieIdentity {
  if (!req.headers.cookie) return { status: 'missing' };
  let cookies: Record<string, string | undefined>;
  try {
    cookies = deps.parseCookies(req.headers.cookie);
  } catch {
    return { status: 'invalid' };
  }
  const refreshToken = cookies.refreshToken;
  if (!refreshToken) return { status: 'missing' };
  const openId = cookies.token_provider === 'openid' && deps.isOpenIdReuseEnabled();
  const token = openId ? cookies.openid_user_id : refreshToken;
  const secret = deps.getSecret();
  if (!token || !secret) return { status: 'invalid' };
  let payload: JwtPayload;
  try {
    const verified = jwt.verify(token, secret);
    if (typeof verified === 'string') return { status: 'invalid' };
    payload = verified;
  } catch {
    return { status: 'invalid' };
  }
  const userId = payload.id;
  if (typeof userId !== 'string' || !/^[0-9a-f]{24}$/i.test(userId)) {
    return { status: 'invalid' };
  }
  const issuance: TokenIssuance = {
    issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
    issuedAtMs: typeof payload.issuedAtMs === 'number' ? payload.issuedAtMs : undefined,
  };
  if (openId) {
    if (typeof payload.refreshTokenHash !== 'string') {
      return refreshToken === req.session?.openidTokens?.refreshToken
        ? { status: 'verified', userId, ...issuance }
        : { status: 'invalid' };
    }
    const hash = createHash('sha256').update(refreshToken).digest('base64url');
    if (payload.refreshTokenHash !== hash) return { status: 'invalid' };
  }
  return { status: 'verified', userId, refreshToken, ...issuance };
}

async function hasCookieSession(
  identity: VerifiedCookieIdentity,
  deps: CookieAuthenticationDeps,
): Promise<boolean> {
  if (!identity.refreshToken) return true;
  const { userId, refreshToken } = identity;
  return !!(await deps.asSystem(() => deps.findSession({ userId, refreshToken })));
}

/** Shared authentication for browser image, video and file requests without bearer headers. */
export async function authenticateCookieRequest(
  req: CookieRequest,
  deps: CookieAuthenticationDeps,
): Promise<CookieAuthResult> {
  const identity = verifyCookieIdentity(req, deps);
  if (identity.status !== 'verified') return identity;
  const { userId, issuedAt, issuedAtMs } = identity;
  return (await hasCookieSession(identity, deps))
    ? { status: 'authenticated', userId, issuedAt, issuedAtMs }
    : { status: 'invalid' };
}

type CookieUser = Pick<
  TwoFactorAccount,
  | 'provider'
  | 'orgId'
  | 'storageRegion'
  | 'twoFactorEnabled'
  | 'twoFactorEnrolledAt'
  | 'credentialsChangedAt'
> & {
  id?: string;
  role?: string;
  tenantId?: string;
  idOnTheSource?: string | null;
  agentTriggerDeletionStartedAt?: Date | null;
};
type CookieViewer = CookieUser & { id: string; role: string; idOnTheSource: string | null };

/**
 * Leaves authorization to the consuming route and reuses an already loaded bearer user. A viewer
 * who still owes required two-factor enrollment, or whose cookie predates enrollment or a password
 * reset, stays anonymous and loses the CDN cookies minted for that session.
 */
export function createOptionalCookieAuth(
  deps: CookieAuthenticationDeps & {
    getUserById(id: string, select: string): Promise<CookieUser | null>;
    clearCloudFrontCookies(res: Response, scope: CloudFrontCookieScope): void;
    enrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
    tokenRetired?: typeof isTokenRetired;
    log(error: Error): void;
  },
): RequestHandler {
  const enrollmentRequired = deps.enrollmentRequired ?? isTwoFactorEnrollmentRequired;
  const tokenRetired = deps.tokenRetired ?? isTokenRetired;

  const resolveViewer = async (req: Request, res: Response): Promise<CookieViewer | undefined> => {
    const identity = verifyCookieIdentity(req as CookieRequest, deps);
    if (identity.status !== 'verified') return undefined;
    const [activeSession, user] = await Promise.all([
      hasCookieSession(identity, deps),
      deps.asSystem(() =>
        deps.getUserById(
          identity.userId,
          '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
        ),
      ),
    ]);
    if (!activeSession || !user || user.agentTriggerDeletionStartedAt) return undefined;
    if (enrollmentRequired(user) || tokenRetired(identity, user)) {
      deps.clearCloudFrontCookies(res, {
        userId: identity.userId,
        tenantId: user.tenantId ?? user.orgId,
        storageRegion: user.storageRegion,
      });
      return undefined;
    }
    return {
      ...user,
      id: identity.userId,
      role: user.role || SystemRoles.USER,
      idOnTheSource: user.idOnTheSource ?? null,
    };
  };

  return async (req, res, next) => {
    if (req.user) {
      clearEnrollmentViewer(req, res, req.user, deps);
      return next();
    }
    try {
      const viewer = await resolveViewer(req, res);
      if (viewer) req.user = viewer;
    } catch (error) {
      deps.log(error instanceof Error ? error : new Error('Cookie authentication failed.'));
    }
    next();
  };
}
