import { logger } from '@librechat/data-schemas';
import { TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE } from 'librechat-data-provider';
import type { TwoFactorEnrollmentUpdate } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { TwoFactorEnrollmentDependencies, StoredTwoFactorAccount } from './twoFactor';
import type { UserDocumentId } from '~/auth/verification';
import {
  TOKEN_RETIREMENT_FIELDS,
  acknowledgeTwoFactorSetup,
  confirmTwoFactorSetup,
  finalizeTwoFactorSetup,
  generateTwoFactorSetupAcknowledgementToken,
  generateTwoFactorSetupFinalizationToken,
  isCredentialLoginBlockedByTwoFactorPolicy,
  isEnrollmentSupersededByRecovery,
  isTokenRetired,
  verifyTwoFactorLoginChallengeToken,
} from './twoFactor';
import { sanitizeUserForResponse } from './user';
import { clearCloudFrontCookies } from '~/cdn';

type LoginChallengeBody = { tempToken?: string; token?: string; backupCode?: string };
type SetupBody = { token?: string };
type ChallengeRequest = Request<Record<string, string>, object, LoginChallengeBody>;
type SetupRequest = Request<Record<string, string>, object, SetupBody> & {
  user?: { id: string };
  twoFactorEnrollmentNonce?: string;
};

export function clearEnrollmentNonces(
  update: TwoFactorEnrollmentUpdate,
): TwoFactorEnrollmentUpdate {
  return {
    ...update,
    twoFactorAcknowledgementNonceHash: null,
    twoFactorFinalizationNonceHash: null,
  };
}

export interface EnrollmentControllerDependencies
  extends Omit<TwoFactorEnrollmentDependencies, 'getUserById' | 'getTOTPSecret' | 'verifyTOTP'> {
  getUserById: (userId: string, projection: string) => Promise<StoredTwoFactorAccount | null>;
  getTOTPSecret: (storedSecret: string | null | undefined) => Promise<string | null>;
  verifyTOTP: (secret: string | null, token: string) => Promise<boolean>;
  verifyBackupCode: (input: {
    user: StoredTwoFactorAccount;
    backupCode: string;
  }) => Promise<boolean>;
  deleteAllUserSessions: (input: { userId: string }) => Promise<object>;
  clearCloudFrontCookies: typeof clearCloudFrontCookies;
  setAuthTokens: (
    userId: UserDocumentId,
    res: Response,
    unused: null,
    req: Request,
  ) => Promise<string>;
}

interface EnrollmentControllers {
  verify2FAWithTempToken: (req: ChallengeRequest, res: Response) => Promise<Response>;
  confirm2FASetupWithTempToken: (req: SetupRequest, res: Response) => Promise<Response>;
  acknowledge2FASetup: (req: SetupRequest, res: Response) => Promise<Response>;
  finalize2FASetup: (req: SetupRequest, res: Response) => Promise<Response>;
}

export function createEnrollmentControllers(
  deps: EnrollmentControllerDependencies,
): EnrollmentControllers {
  const sanitizeUser = (user: StoredTwoFactorAccount) => ({
    ...sanitizeUserForResponse(user),
    id: user._id.toString(),
  });

  const revokeMintedSession = async (
    res: Response,
    user: StoredTwoFactorAccount,
    userId: string,
  ): Promise<void> => {
    await deps.deleteAllUserSessions({ userId });
    res.clearCookie('refreshToken');
    res.clearCookie('token_provider');
    deps.clearCloudFrontCookies(res, {
      userId,
      tenantId: user.tenantId ?? user.orgId,
      storageRegion: user.storageRegion,
    });
  };

  const verify2FAWithTempToken = async (
    req: ChallengeRequest,
    res: Response,
  ): Promise<Response> => {
    try {
      const { tempToken, token, backupCode } = req.body;
      if (!tempToken) {
        return res.status(400).json({ message: 'Missing temporary token' });
      }

      const credential = verifyTwoFactorLoginChallengeToken(tempToken, process.env.JWT_SECRET);
      if (!credential) {
        return res.status(401).json({ message: 'Invalid or expired temporary token' });
      }

      const user = await deps.getUserById(credential.userId, '+totpSecret +backupCodes');
      if (!user || !user.twoFactorEnabled) {
        return res.status(400).json({ message: '2FA is not enabled for this user' });
      }

      if (isCredentialLoginBlockedByTwoFactorPolicy(user)) {
        logger.warn(
          `[verify2FAWithTempToken] Refused a password challenge for a federated record under required 2FA [provider: ${user.provider}]`,
        );
        return res.status(403).json({
          code: TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE,
          message: 'Sign in with your identity provider to continue.',
        });
      }

      if (isTokenRetired(credential, user)) {
        logger.warn(
          `[verify2FAWithTempToken] Challenge predates enrollment or password reset: userId=${credential.userId}`,
        );
        return res.status(401).json({ message: 'Invalid or expired temporary token' });
      }

      const secret = await deps.getTOTPSecret(user.totpSecret);
      let isVerified = false;
      if (token) {
        isVerified = await deps.verifyTOTP(secret, token);
      } else if (backupCode) {
        isVerified = await deps.verifyBackupCode({ user, backupCode });
      }

      if (!isVerified) {
        return res.status(401).json({ message: 'Invalid 2FA code or backup code' });
      }

      const userData = sanitizeUser(user);
      const authToken = await deps.setAuthTokens(user._id, res, null, req);
      const retirement = await deps.getUserById(credential.userId, TOKEN_RETIREMENT_FIELDS);
      if (isTokenRetired(credential, retirement)) {
        logger.warn(
          `[verify2FAWithTempToken] Password was reset while the challenge was being verified: userId=${credential.userId}`,
        );
        await revokeMintedSession(res, user, credential.userId);
        return res.status(401).json({ message: 'Invalid or expired temporary token' });
      }

      return res.status(200).json({ token: authToken, user: userData });
    } catch (err) {
      logger.error('[verify2FAWithTempToken]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  const confirm2FASetupWithTempToken = async (
    req: SetupRequest,
    res: Response,
  ): Promise<Response> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Invalid or expired two-factor setup token' });
      }

      const result = await confirmTwoFactorSetup(userId, req.body?.token, deps);
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }

      const acknowledgementToken = generateTwoFactorSetupAcknowledgementToken(
        userId,
        result.acknowledgementNonce,
        process.env.JWT_SECRET!,
      );
      return res.status(200).json({ backupCodes: result.plainCodes, acknowledgementToken });
    } catch (err) {
      logger.error('[confirm2FASetupWithTempToken]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  const acknowledge2FASetup = async (req: SetupRequest, res: Response): Promise<Response> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res
          .status(401)
          .json({ message: 'Invalid or expired two-factor acknowledgement token' });
      }

      const result = await acknowledgeTwoFactorSetup(userId, req.twoFactorEnrollmentNonce, deps);
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }

      const finalizationToken = generateTwoFactorSetupFinalizationToken(
        userId,
        result.finalizationNonce,
        process.env.JWT_SECRET!,
      );
      return res.status(200).json({ finalizationToken });
    } catch (err) {
      logger.error('[acknowledge2FASetup]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  const finalize2FASetup = async (req: SetupRequest, res: Response): Promise<Response> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res
          .status(401)
          .json({ message: 'Invalid or expired two-factor finalization token' });
      }

      const result = await finalizeTwoFactorSetup(userId, req.twoFactorEnrollmentNonce, deps);
      if (!result.ok) {
        return res.status(result.status).json({ message: result.message });
      }

      const userData = sanitizeUser(result.user);
      await deps.deleteAllUserSessions({ userId: result.user._id.toString() });
      const authToken = await deps.setAuthTokens(result.user._id, res, null, req);
      const retirement = await deps.getUserById(userId, TOKEN_RETIREMENT_FIELDS);
      if (
        isEnrollmentSupersededByRecovery(
          result.user.twoFactorEnrolledAt,
          retirement?.credentialsChangedAt,
        )
      ) {
        await revokeMintedSession(res, result.user, userId);
        return res
          .status(401)
          .json({ message: 'Password was reset during setup, please sign in again' });
      }

      return res.status(200).json({ token: authToken, user: userData });
    } catch (err) {
      logger.error('[finalize2FASetup]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  return {
    verify2FAWithTempToken,
    confirm2FASetupWithTempToken,
    acknowledge2FASetup,
    finalize2FASetup,
  };
}
