import { logger } from '@librechat/data-schemas';
import type { UserDocumentId } from './verification';
import { getSafeErrorMetadata } from '../utils/errors';

export const PASSWORD_RESET_REQUEST_MESSAGE: string =
  'If an account with that email exists, a password reset link has been sent to it.';

interface PasswordResetRecipient {
  _id: UserDocumentId;
  email: string;
  name?: string;
  username?: string;
}

interface ResetTokenQuery {
  userId: UserDocumentId;
  type: 'password_reset' | null;
  token?: string;
  email?: null;
  identifier?: null;
}

export interface PasswordResetRequestDeps {
  deleteTokens: (query: ResetTokenQuery) => Promise<{ deletedCount?: number }>;
  createToken: (data: {
    userId: UserDocumentId;
    email: string;
    type: 'password_reset';
    token: string;
    createdAt: number;
    expiresIn: number;
  }) => Promise<object>;
  createTokenHash: () => Promise<[string, string]>;
  sendEmail: (data: {
    email: string;
    subject: string;
    payload: { appName: string; name: string; link: string; year: number };
    template: string;
  }) => Promise<object | void>;
}

export interface PasswordResetRequestInput {
  user: PasswordResetRecipient | null;
  emailEnabled: boolean;
  clientUrl: string;
  appName: string;
}

/** The public response never carries recovery credentials, even if delivery fails. */
export async function issuePasswordReset(
  deps: PasswordResetRequestDeps,
  { user, emailEnabled, clientUrl, appName }: PasswordResetRequestInput,
): Promise<{ message: string }> {
  if (!emailEnabled || !user) {
    return { message: PASSWORD_RESET_REQUEST_MESSAGE };
  }

  await Promise.all([
    deps.deleteTokens({ userId: user._id, type: 'password_reset' }),
    deps.deleteTokens({ userId: user._id, email: null, identifier: null, type: null }),
  ]);

  const [resetToken, hash] = await deps.createTokenHash();
  await deps.createToken({
    userId: user._id,
    email: user.email.toLowerCase(),
    type: 'password_reset',
    token: hash,
    createdAt: Date.now(),
    expiresIn: 900,
  });

  try {
    await deps.sendEmail({
      email: user.email,
      subject: 'Password Reset Request',
      payload: {
        appName,
        name: user.name || user.username || user.email,
        link: `${clientUrl}/reset-password?token=${resetToken}&userId=${user._id}`,
        year: new Date().getFullYear(),
      },
      template: 'requestPasswordReset.handlebars',
    });
  } catch (error) {
    logger.error('[requestPasswordReset] Email delivery failed', getSafeErrorMetadata(error));
    try {
      // Do not revoke a concurrent request's token when this delivery fails.
      await deps.deleteTokens({ userId: user._id, type: 'password_reset', token: hash });
    } catch (cleanupError) {
      logger.error(
        '[requestPasswordReset] Undelivered token cleanup failed',
        getSafeErrorMetadata(cleanupError),
      );
    }
    return { message: PASSWORD_RESET_REQUEST_MESSAGE };
  }

  logger.info(`[requestPasswordReset] Link emailed. [User ID: ${user._id}]`);
  return { message: PASSWORD_RESET_REQUEST_MESSAGE };
}
