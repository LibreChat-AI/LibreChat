import type { IUser, TwoFactorEnrollmentUpdate } from '@librechat/data-schemas';

export type PasswordResetUpdate = Pick<IUser, 'password' | 'credentialsChangedAt'> &
  Pick<
    TwoFactorEnrollmentUpdate,
    | 'pendingTotpSecret'
    | 'pendingBackupCodes'
    | 'twoFactorAcknowledgementNonceHash'
    | 'twoFactorFinalizationNonceHash'
  >;

/**
 * Retire bearer credentials from the replaced password. Clearing the staged enrollment in this
 * same write prevents an old setup credential from promoting its secret after recovery.
 */
export function createPasswordResetUpdate(
  passwordHash: string,
  resetAt: Date = new Date(),
): PasswordResetUpdate {
  return {
    password: passwordHash,
    credentialsChangedAt: resetAt,
    pendingTotpSecret: null,
    pendingBackupCodes: [],
    twoFactorAcknowledgementNonceHash: null,
    twoFactorFinalizationNonceHash: null,
  };
}
