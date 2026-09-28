import jwt from 'jsonwebtoken';
import { TWO_FACTOR_ENROLLMENT_REQUIRED_CODE } from 'librechat-data-provider';
import type { ISession, OIDCTokens } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { TokenIssuance, TwoFactorAccount } from './twoFactor';
import {
  generateTwoFactorSetupToken,
  isTokenRetired,
  recheckMintedCredential,
  isTwoFactorEnrollmentRequired,
  TOKEN_RETIREMENT_FIELDS,
} from './twoFactor';

const EXPIRED_REFRESH_MESSAGE = 'Refresh token expired or not found for this user';

type UserIdentifier = string | { toString(): string };

type RefreshUser = Pick<
  TwoFactorAccount,
  | '_id'
  | 'provider'
  | 'tenantId'
  | 'orgId'
  | 'storageRegion'
  | 'twoFactorEnabled'
  | 'twoFactorEnrolledAt'
  | 'credentialsChangedAt'
>;

type RefreshSession = Pick<ISession, 'expiration'> & { _id: UserIdentifier };
type SessionDeletionResult = { deletedCount?: number };
type AuthResponseSource = TwoFactorAccount & { __v?: number; federatedTokens?: OIDCTokens };

interface LocalRefreshDependencies {
  userProjection: string;
  getUserById: (userId: string, projection: string) => Promise<RefreshUser | null>;
  findSession: (
    query: { userId: string; refreshToken: string },
    options: { lean: false },
  ) => Promise<RefreshSession | null>;
  setAuthTokens: (
    userId: string,
    res: Response,
    session: RefreshSession | null,
    req: Request,
  ) => Promise<string>;
  deleteSession: (query: { sessionId: string }) => Promise<SessionDeletionResult>;
  deleteAllUserSessions: (query: { userId: string }) => Promise<SessionDeletionResult>;
  clearCloudFrontCookies: (
    res: Response,
    scope: { userId: string; tenantId?: string; storageRegion?: string },
  ) => void;
  generateTwoFactorSetupToken?: typeof generateTwoFactorSetupToken;
  isTwoFactorEnrollmentRequired?: typeof isTwoFactorEnrollmentRequired;
  warn: (message: string) => void;
  error: (message: string, cause: unknown) => void;
}

/**
 * Preserve the refresh response contract. The shared allowlist excludes `openidId`, which existing
 * OpenID refresh clients receive and the controller tests assert, so switching sanitizers here
 * would silently change the response shape.
 */
export function sanitizeUserForAuthResponse<T extends object>(
  user: T | null | undefined,
): Partial<T> {
  const hydrated = user as (T & { toObject?: () => AuthResponseSource }) | null | undefined;
  const source = (typeof hydrated?.toObject === 'function' ? hydrated.toObject() : hydrated) ?? {};
  const {
    password: _password,
    __v: _version,
    totpSecret: _totpSecret,
    backupCodes: _backupCodes,
    pendingTotpSecret: _pendingTotpSecret,
    pendingBackupCodes: _pendingBackupCodes,
    twoFactorAcknowledgementNonceHash: _acknowledgementHash,
    twoFactorFinalizationNonceHash: _finalizationHash,
    federatedTokens: _federatedTokens,
    ...safeUser
  } = source as AuthResponseSource;
  return safeUser as Partial<T>;
}

/** Handles only the local refresh branch after OpenID ownership has been resolved. */
export function createLocalRefreshHandler(deps: LocalRefreshDependencies) {
  const requiresEnrollment = deps.isTwoFactorEnrollmentRequired ?? isTwoFactorEnrollmentRequired;
  const mintSetupToken = deps.generateTwoFactorSetupToken ?? generateTwoFactorSetupToken;

  /**
   * The session lookup resolves before the response credential is minted. Recovery may land in
   * between, deleting the old session while the newly minted token postdates credentialsChangedAt.
   * Read the cutoff after minting so that race withdraws the resurrected session.
   */
  const isCredentialRetired = async (userId: string, credential: TokenIssuance) => {
    const current = await deps.getUserById(userId, TOKEN_RETIREMENT_FIELDS);
    return isTokenRetired(credential, current);
  };

  const revokeSession = async (res: Response, user: RefreshUser, userId: string) => {
    await deps.deleteAllUserSessions({ userId });
    res.clearCookie('refreshToken');
    res.clearCookie('token_provider');
    deps.clearCloudFrontCookies(res, {
      userId,
      tenantId: user.tenantId ?? user.orgId,
      storageRegion: user.storageRegion,
    });
  };

  const withdrawSession = async (res: Response, user: RefreshUser, userId: string) => {
    deps.warn(
      `[refreshController] Password was reset while the refresh was in flight: userId=${userId}`,
    );
    await revokeSession(res, user, userId);
    return res.status(401).send(EXPIRED_REFRESH_MESSAGE);
  };

  return async (
    req: Request,
    res: Response,
    refreshToken: string | undefined,
  ): Promise<Response | void> => {
    if (!refreshToken) {
      return res.status(200).send('Refresh token not provided');
    }

    try {
      const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET ?? '');
      if (typeof payload === 'string' || typeof payload.id !== 'string') {
        throw new Error('Invalid refresh token payload');
      }
      const userId = payload.id;
      const user = await deps.getUserById(userId, deps.userProjection);
      if (!user) {
        return res.status(401).redirect('/login');
      }

      const credential: TokenIssuance = {
        issuedAt: payload.iat,
        issuedAtMs: typeof payload.issuedAtMs === 'number' ? payload.issuedAtMs : undefined,
      };
      /**
       * Enrollment stamps its cutoff before session revocation. Dating the incoming credential
       * closes that gap even if revocation fails, and also covers password recovery.
       */
      if (isTokenRetired(credential, user)) {
        deps.warn(
          `[refreshController] Refresh token predates enrollment or password reset: userId=${userId}`,
        );
        res.clearCookie('refreshToken');
        return res.status(401).send(EXPIRED_REFRESH_MESSAGE);
      }

      if (process.env.NODE_ENV === 'CI') {
        const token = await deps.setAuthTokens(userId, res, null, req);
        return res.status(200).send({ token, user: sanitizeUserForAuthResponse(user) });
      }

      const session = await deps.findSession({ userId, refreshToken }, { lean: false });
      if (session && session.expiration > new Date()) {
        if (requiresEnrollment(user)) {
          await deps.deleteSession({ sessionId: session._id.toString() });
          res.clearCookie('refreshToken');
          deps.clearCloudFrontCookies(res, {
            userId,
            tenantId: user.tenantId ?? user.orgId,
            storageRegion: user.storageRegion,
          });
          /** The setup token outranks the refresh credential that bought it. */
          const tempToken = mintSetupToken(userId, process.env.JWT_SECRET ?? '');
          if (await isCredentialRetired(userId, credential)) {
            return withdrawSession(res, user, userId);
          }
          return res.status(200).send({
            code: TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
            twoFAPending: true,
            twoFASetupRequired: true,
            tempToken,
          });
        }

        const token = await deps.setAuthTokens(userId, res, session, req);
        const retired = await recheckMintedCredential(
          () => isCredentialRetired(userId, credential),
          () => revokeSession(res, user, userId),
        );
        if (retired) {
          return withdrawSession(res, user, userId);
        }
        return res.status(200).send({ token, user: sanitizeUserForAuthResponse(user) });
      }
      if (req.query?.retry) {
        return res.status(403).send('No session found');
      }
      if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) {
        return res.status(403).redirect('/login');
      }
      return res.status(401).send(EXPIRED_REFRESH_MESSAGE);
    } catch (error) {
      deps.error('[refreshController] Invalid refresh token:', error);
      return res.status(403).send('Invalid refresh token');
    }
  };
}
