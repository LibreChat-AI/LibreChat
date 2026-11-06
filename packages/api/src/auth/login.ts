import { logger } from '@librechat/data-schemas';
import {
  TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
  TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE,
} from 'librechat-data-provider';
import type { AuthMethod } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { StoredTwoFactorAccount } from './twoFactor';
import type { UserDocumentId } from '~/auth/verification';
import {
  TOKEN_RETIREMENT_FIELDS,
  recheckMintedCredential,
  withdrawMintedSession,
  generateTwoFactorSetupToken,
  hasPasswordResetSince,
  isCredentialLoginBlockedByTwoFactorPolicy,
  isTwoFactorEnrollmentRequired,
} from './twoFactor';
import { clearCloudFrontCookies } from '~/cdn';

type LoginUser = StoredTwoFactorAccount & { __v?: number };
/** `authMethod` is set by a caller chained ahead of this controller (e.g. passkey) to override
 *  `defaultAuthMethod` for that one request. */
type LoginRequest = Request & { user?: LoginUser; authMethod?: AuthMethod };

export interface LoginDependencies {
  getUserById: (userId: string, projection: string) => Promise<StoredTwoFactorAccount | null>;
  deleteAllUserSessions: (input: { userId: string }) => Promise<object>;
  clearCloudFrontCookies: typeof clearCloudFrontCookies;
  generate2FATempToken: (userId: UserDocumentId) => string;
  setAuthTokens: (
    userId: UserDocumentId,
    res: Response,
    unused: null,
    req: Request,
    options?: { authMethod?: AuthMethod },
  ) => Promise<string>;
  /** The method this controller's mount records for a request that did not override it, e.g.
   *  `'ldap'` on a deployment with `LDAP_URL` set, otherwise `'local'`. */
  defaultAuthMethod: AuthMethod;
}

export function createLoginController(deps: LoginDependencies) {
  const wasPasswordRevokedDuringLogin = async (user: LoginUser): Promise<boolean> => {
    const current = await deps.getUserById(user._id.toString(), TOKEN_RETIREMENT_FIELDS);
    return hasPasswordResetSince(user.credentialsChangedAt, current?.credentialsChangedAt);
  };

  const refuseRevokedLogin = (res: Response, user: LoginUser): Response => {
    logger.warn(
      `[loginController] Refused a login whose password was reset while it was in flight [userId: ${user._id}]`,
    );
    return res.status(401).json({ message: 'Invalid credentials' });
  };

  const withdrawLoginSession = (res: Response, user: LoginUser): Promise<void> =>
    withdrawMintedSession(res, user, user._id.toString(), deps);

  return async (req: LoginRequest, res: Response): Promise<Response> => {
    try {
      if (!req.user) {
        return res.status(400).json({ message: 'Invalid credentials' });
      }

      if (isCredentialLoginBlockedByTwoFactorPolicy(req.user)) {
        logger.warn(
          `[loginController] Refused a password login for a federated record under required 2FA [provider: ${req.user.provider}] [Request-IP: ${req.ip}]`,
        );
        return res.status(403).json({
          code: TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE,
          message: 'Sign in with your identity provider to continue.',
        });
      }

      if (req.user.twoFactorEnabled) {
        const tempToken = deps.generate2FATempToken(req.user._id);
        if (await wasPasswordRevokedDuringLogin(req.user)) {
          return refuseRevokedLogin(res, req.user);
        }
        return res.status(200).json({ twoFAPending: true, tempToken });
      }

      if (isTwoFactorEnrollmentRequired(req.user)) {
        deps.clearCloudFrontCookies(res, {
          userId: req.user._id.toString(),
          tenantId: req.user.tenantId ?? req.user.orgId,
          storageRegion: req.user.storageRegion,
        });
        const tempToken = generateTwoFactorSetupToken(
          req.user._id.toString(),
          process.env.JWT_SECRET!,
        );
        if (await wasPasswordRevokedDuringLogin(req.user)) {
          return refuseRevokedLogin(res, req.user);
        }
        return res.status(200).json({
          code: TWO_FACTOR_ENROLLMENT_REQUIRED_CODE,
          twoFAPending: true,
          twoFASetupRequired: true,
          tempToken,
        });
      }

      const { password: _p, totpSecret: _t, __v, ...user } = req.user;
      user.id = user._id.toString();

      const loginUser = req.user;
      const token = await deps.setAuthTokens(loginUser._id, res, null, req, {
        authMethod: req.authMethod ?? deps.defaultAuthMethod,
      });
      const revoked = await recheckMintedCredential(
        () => wasPasswordRevokedDuringLogin(loginUser),
        () => withdrawLoginSession(res, loginUser),
      );
      if (revoked) {
        await withdrawLoginSession(res, loginUser);
        return refuseRevokedLogin(res, loginUser);
      }

      return res.status(200).send({ token, user });
    } catch (err) {
      logger.error('[loginController]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };
}
