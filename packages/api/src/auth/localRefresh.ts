import jwt from 'jsonwebtoken';
import { TWO_FACTOR_ENROLLMENT_REQUIRED_CODE } from 'librechat-data-provider';
import { hashToken, REFRESH_TOKEN_ROTATED, DEFAULT_SESSION_EXPIRY } from '@librechat/data-schemas';
import type { ISession, OIDCTokens } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { TokenIssuance, TwoFactorAccount } from './twoFactor';
import {
  generateTwoFactorSetupToken,
  isTokenRetired,
  recheckMintedCredential,
  withdrawMintedSession,
  isTwoFactorEnrollmentRequired,
  TOKEN_RETIREMENT_FIELDS,
} from './twoFactor';
import { clearSessionHintCookie } from '~/oauth/csrf';
import { math } from '~/utils/math';

const EXPIRED_REFRESH_MESSAGE = 'Refresh token expired or not found for this user';

/**
 * Default of `REFRESH_TOKEN_GRACE_MS`, how long a refresh may still present the token that a
 * rotation replaced. Tabs share one refresh cookie, so one tab can send it while another tab's
 * refresh is replacing it. The window only has to outlast such a request, like the OpenID
 * refresh-token bridge's `OPENID_REFRESH_BRIDGE_GRACE_MS`.
 */
const DEFAULT_ROTATION_GRACE_MS = 60_000;

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

type RefreshSession = Pick<ISession, 'expiration' | 'previousRefreshTokenHash'> & {
  _id: UserIdentifier;
};
type SessionDeletionResult = { deletedCount?: number };
type AuthResponseSource = TwoFactorAccount & { __v?: number; federatedTokens?: OIDCTokens };

interface LocalRefreshDependencies {
  userProjection: string;
  getUserById: (userId: string, projection: string) => Promise<RefreshUser | null>;
  findSession: (
    query: { userId: string; refreshToken: string },
    options: { lean: false; graceMs: number },
  ) => Promise<RefreshSession | null>;
  /** Mints an access token without touching the refresh session. */
  generateToken: (user: RefreshUser, expiresIn: number) => Promise<string>;
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

  const revokeSession = (res: Response, user: RefreshUser, userId: string) =>
    withdrawMintedSession(res, user, userId, deps);

  const withdrawSession = async (res: Response, user: RefreshUser, userId: string) => {
    deps.warn(
      `[refreshController] Password was reset while the refresh was in flight: userId=${userId}`,
    );
    await revokeSession(res, user, userId);
    return res.status(401).send(EXPIRED_REFRESH_MESSAGE);
  };

  const findSession = (userId: string, refreshToken: string) =>
    deps.findSession(
      { userId, refreshToken },
      {
        lean: false,
        graceMs: math(process.env.REFRESH_TOKEN_GRACE_MS, DEFAULT_ROTATION_GRACE_MS),
      },
    );

  const mintAccessToken = (user: RefreshUser) =>
    deps.generateToken(user, math(process.env.SESSION_EXPIRY, DEFAULT_SESSION_EXPIRY));

  /**
   * Rotates the session, unless another refresh already replaced the presented token. That refresh's
   * response carries the new cookie, and rotating again would orphan whichever cookie lands first,
   * so this refresh gets an access token alone.
   */
  const issueToken = async (
    req: Request,
    res: Response,
    {
      userId,
      user,
      session,
      refreshToken,
    }: { userId: string; user: RefreshUser; session: RefreshSession; refreshToken: string },
  ): Promise<string | null> => {
    const previous = session.previousRefreshTokenHash;
    if (previous && previous === (await hashToken(refreshToken))) {
      return mintAccessToken(user);
    }

    try {
      return await deps.setAuthTokens(userId, res, session, req);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== REFRESH_TOKEN_ROTATED) {
        throw error;
      }
    }

    /** A refresh that read the session at the same time rotated it first, unless it was revoked. */
    const rotated = await findSession(userId, refreshToken);
    return rotated && rotated.expiration > new Date() ? mintAccessToken(user) : null;
  };

  return async (
    req: Request,
    res: Response,
    refreshToken: string | undefined,
  ): Promise<Response | void> => {
    if (!refreshToken) {
      clearSessionHintCookie(res);
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
        clearSessionHintCookie(res);
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
        clearSessionHintCookie(res);
        return res.status(401).send(EXPIRED_REFRESH_MESSAGE);
      }

      if (process.env.NODE_ENV === 'CI') {
        const token = await deps.setAuthTokens(userId, res, null, req);
        return res.status(200).send({ token, user: sanitizeUserForAuthResponse(user) });
      }

      const session = await findSession(userId, refreshToken);
      if (session && session.expiration > new Date()) {
        if (requiresEnrollment(user)) {
          await deps.deleteSession({ sessionId: session._id.toString() });
          res.clearCookie('refreshToken');
          clearSessionHintCookie(res);
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

        const token = await issueToken(req, res, { userId, user, session, refreshToken });
        if (token != null) {
          const retired = await recheckMintedCredential(
            () => isCredentialRetired(userId, credential),
            () => revokeSession(res, user, userId),
          );
          if (retired) {
            return withdrawSession(res, user, userId);
          }
          return res.status(200).send({ token, user: sanitizeUserForAuthResponse(user) });
        }
      }
      clearSessionHintCookie(res);
      if (req.query?.retry) {
        return res.status(403).send('No session found');
      }
      if (typeof payload.exp === 'number' && payload.exp < Date.now() / 1000) {
        return res.status(403).redirect('/login');
      }
      return res.status(401).send(EXPIRED_REFRESH_MESSAGE);
    } catch (error) {
      deps.error('[refreshController] Invalid refresh token:', error);
      clearSessionHintCookie(res);
      return res.status(403).send('Invalid refresh token');
    }
  };
}
