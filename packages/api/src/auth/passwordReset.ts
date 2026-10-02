import { logger } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { PasswordResetUpdate } from './passwordResetUpdate';
import { createPasswordResetUpdate } from './passwordResetUpdate';
import { EMAIL_CHANGE_TOKEN_TYPE } from './email';

/** The stored reset token, in both the typed shape and the untyped legacy one. */
export interface PasswordResetToken {
  token: string;
  email?: string | null;
  type?: string | null;
}

export interface PasswordResetUser {
  _id?: string;
  email: string;
  name?: string;
  username?: string;
  /** Set when a confirmed email change commits; absent on documents written before it. */
  emailChangedAt?: Date | string | null;
}

export interface PasswordResetDeps {
  findResetToken: (userId: string) => Promise<PasswordResetToken | null>;
  getUserById: (userId: string, select: string) => Promise<PasswordResetUser | null>;
  updateUser: (
    userId: string,
    update: PasswordResetUpdate,
    expectedState: { email: string },
  ) => Promise<PasswordResetUser | null>;
  deleteTokens: (query: { userId: string; type: string }) => Promise<unknown>;
  compareToken: (candidate: string, storedHash: string) => boolean;
  hashPassword: (password: string) => string;
}

export interface PasswordResetInput {
  userId: string;
  token: string;
  password: string;
}

export interface PasswordResetControllerDeps {
  resetPassword: (
    userId: string,
    token: string,
    password: string,
  ) => Promise<{ message: string } | Error>;
  deleteAllUserSessions: (query: { userId: string }) => Promise<{ deletedCount?: number }>;
  deletePasskeysByUser: (userId: string) => Promise<{ deletedCount?: number }>;
  /** Resolves once no cached auth document from before the reset can be served. */
  awaitAuthUserDocEviction: (userId: string) => Promise<void>;
}

export type PasswordResetOutcome =
  | { ok: true; user: PasswordResetUser; resetToken: PasswordResetToken }
  | { ok: false };

export const PASSWORD_RESET_USER_FIELDS: string = 'email _id name username emailChangedAt';

export function createResetPasswordController(deps: PasswordResetControllerDeps) {
  return async (
    req: Request<Record<string, string>, object, PasswordResetInput>,
    res: Response,
  ): Promise<Response> => {
    try {
      const { userId, token, password } = req.body;
      const result = await deps.resetPassword(userId, token, password);
      if (result instanceof Error) {
        return res.status(400).json(result);
      }

      const [sessions, passkeys] = await Promise.allSettled([
        Promise.resolve().then(() => deps.deleteAllUserSessions({ userId })),
        Promise.resolve().then(() => deps.deletePasskeysByUser(userId)),
      ]);
      if (sessions.status === 'rejected') {
        logger.error(
          `[resetPasswordController] Failed to revoke sessions for user ${userId}`,
          sessions.reason,
        );
      }
      if (passkeys.status === 'rejected') {
        logger.error(
          `[resetPasswordController] Failed to revoke passkeys for user ${userId}`,
          passkeys.reason,
        );
      }
      /** After the revocations, so nothing can mint a post-stamp token while it waits. */
      await deps.awaitAuthUserDocEviction(userId);

      return res.status(200).json(result);
    } catch (error) {
      logger.error('[resetPasswordController]', error);
      return res.status(400).json({ message: error instanceof Error ? error.message : undefined });
    }
  };
}

/**
 * Keyed on the token's address binding rather than its type, so the untyped legacy shape
 * a fallback lookup returns is covered too. Address-less tokens stay usable so links from
 * a not-yet-upgraded node keep working, but never for an account whose address has moved:
 * they cannot be attributed to the current address and would otherwise outlive the change.
 */
export function resetTokenBindsToAccount(
  resetToken: PasswordResetToken,
  user: PasswordResetUser | null,
): boolean {
  if (!user) {
    return false;
  }
  if (resetToken.email) {
    return resetToken.email.toLowerCase() === user.email.toLowerCase();
  }
  return user.emailChangedAt == null;
}

/**
 * Revokes the email changes a reset supersedes. Called immediately after the commit rather
 * than after the notification: the delete is not scoped to the password the pending token
 * was bound to, so every moment it is deferred is a moment an email change request can
 * issue a link against the new password and have it revoked here. Confirmation refuses
 * tokens bound to the old password independently, by re-checking the stored hash.
 */
export async function clearPendingEmailChanges(
  deps: Pick<PasswordResetDeps, 'deleteTokens'>,
  userId: string,
): Promise<void> {
  try {
    await deps.deleteTokens({ userId, type: EMAIL_CHANGE_TOKEN_TYPE });
  } catch (error) {
    logger.error('[resetPassword] Failed to clean up pending email changes', error);
  }
}

/**
 * Validates a reset link against the account it names and commits the new password, so the
 * address binding, the compare-and-set and the email change sweep stay one operation.
 *
 * The token and the account are read together: both depend only on the supplied id, neither
 * is acted on until the validation that owns it passes, and nothing is returned to the
 * caller until the whole check does.
 */
export async function commitPasswordReset(
  deps: PasswordResetDeps,
  input: PasswordResetInput,
): Promise<PasswordResetOutcome> {
  const [resetToken, account] = await Promise.all([
    deps.findResetToken(input.userId),
    deps.getUserById(input.userId, PASSWORD_RESET_USER_FIELDS),
  ]);

  if (!resetToken || !deps.compareToken(input.token, resetToken.token)) {
    return { ok: false };
  }

  if (!resetTokenBindsToAccount(resetToken, account) || !account) {
    return { ok: false };
  }

  const user = await deps.updateUser(
    input.userId,
    createPasswordResetUpdate(deps.hashPassword(input.password)),
    { email: account.email },
  );
  if (!user) {
    return { ok: false };
  }

  await clearPendingEmailChanges(deps, input.userId);

  return { ok: true, user, resetToken };
}
