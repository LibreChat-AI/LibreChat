import { logger } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { PasswordResetUpdate } from './passwordResetUpdate';
import type { TokenRetirementSignals } from './twoFactor';
import { createPasswordResetUpdate } from './passwordResetUpdate';
import { restampRetirementCutoff } from './twoFactor';
import { clearSessionHintCookie } from '~/oauth/csrf';
import { EMAIL_CHANGE_TOKEN_TYPE } from './email';

/** The stored reset token, in both the typed shape and the untyped legacy one. */
export interface PasswordResetToken {
  token: string;
  email?: string | null;
  type?: string | null;
  /** When the link was issued; absent only on documents written before the field existed. */
  createdAt?: Date | string | number | null;
}

export interface PasswordResetUser {
  _id?: string;
  email: string;
  name?: string;
  username?: string;
  /** Set when a confirmed email change commits; absent on documents written before it. */
  emailChangedAt?: Date | string | null;
  /** Set by every password reset; a link issued before it has already been spent. */
  credentialsChangedAt?: Date | string | null;
}

export interface PasswordResetDeps {
  findResetToken: (userId: string) => Promise<PasswordResetToken | null>;
  getUserById: (userId: string, select: string) => Promise<PasswordResetUser | null>;
  updateUser: (
    userId: string,
    update: PasswordResetUpdate,
    expectedState: { email: string; credentialsChangedAt: Date | string | null },
  ) => Promise<PasswordResetUser | null>;
  deleteTokens: (query: { userId: string; type: string }) => Promise<unknown>;
  compareToken: (candidate: string, storedHash: string) => Promise<boolean>;
  hashPassword: (password: string) => Promise<string>;
}

export interface PasswordResetInput {
  userId: string;
  token: string;
  password: string;
}

export interface PasswordResetControllerDeps {
  resetPassword: (userId: string, token: string, password: string) => Promise<PasswordResetResult>;
  deleteAllUserSessions: (query: { userId: string }) => Promise<{ deletedCount?: number }>;
  deletePasskeysByUser: (userId: string) => Promise<{ deletedCount?: number }>;
  /** Resolves once no cached auth document from before the reset can be served. */
  awaitAuthUserDocEviction: (userId: string) => Promise<void>;
  /** Reads and re-dates the cutoff the committed reset stamped. */
  getUserById: (userId: string, select: string) => Promise<TokenRetirementSignals | null>;
  updateUser: (
    userId: string,
    update: { credentialsChangedAt: Date },
    expectedState: { credentialsChangedAt: Date },
  ) => Promise<unknown>;
}

export type PasswordResetOutcome =
  | { ok: true; user: PasswordResetUser; resetToken: PasswordResetToken }
  | { ok: false };

export const PASSWORD_RESET_USER_FIELDS: string =
  'email _id name username emailChangedAt credentialsChangedAt';

/** The password changed but a credential minted during the change may still be accepted. */
export const CREDENTIAL_RETIREMENT_INCOMPLETE = 'CREDENTIAL_RETIREMENT_INCOMPLETE';

export function createResetPasswordController(deps: PasswordResetControllerDeps) {
  /** Runs whether or not the reset could re-date its cutoff: the password has changed either way. */
  const revokeCredentials = async (userId: string) => {
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
    if (sessions.status === 'rejected' || passkeys.status === 'rejected') {
      throw new Error('Sessions or passkeys outlived the reset');
    }
  };

  /** Re-dates the committed cutoff so a credential minted while the write was in flight retires. */
  const restampReset = async (userId: string): Promise<void> => {
    const committed = await deps.getUserById(userId, 'credentialsChangedAt');
    const stampedAt = committed?.credentialsChangedAt;
    if (stampedAt == null) {
      throw new Error('Committed reset has no credentialsChangedAt to re-date');
    }
    await restampRetirementCutoff(
      'credentialsChangedAt',
      userId,
      new Date(stampedAt),
      (cutoff, expectedState) => deps.updateUser(userId, cutoff, expectedState),
    );
  };

  /** Never throws: every step runs, and a failed one only marks the retirement incomplete. */
  const retireCredentials = async (userId: string): Promise<boolean> => {
    let complete = true;
    for (const [label, step] of [
      ['re-date the cutoff', () => restampReset(userId)],
      ['revoke sessions and passkeys', () => revokeCredentials(userId)],
    ] as const) {
      try {
        await step();
      } catch (error) {
        complete = false;
        logger.error(`[resetPasswordController] Failed to ${label} for user ${userId}`, error);
      }
    }
    return complete;
  };

  return async (
    req: Request<Record<string, string>, object, PasswordResetInput>,
    res: Response,
  ): Promise<Response> => {
    const { userId, token, password } = req.body;
    let result: PasswordResetResult;
    try {
      result = await deps.resetPassword(userId, token, password);
    } catch (error) {
      /** Throws only up to and including the password write, never after it commits. */
      logger.error('[resetPasswordController]', error);
      return res.status(400).json({ message: 'Password reset failed' });
    }
    if (!result.ok) {
      return res.status(400).json({ message: 'Invalid or expired password reset token' });
    }

    /** From here the password has changed: retirement runs on every path. */
    const retired = await retireCredentials(userId);
    clearSessionHintCookie(res);
    if (!retired || !result.tokenConsumed) {
      return res.status(500).json({
        code: CREDENTIAL_RETIREMENT_INCOMPLETE,
        message: 'Your password was changed, but other sessions may stay signed in.',
      });
    }
    return res.status(200).json({ message: 'Password reset was successful' });
  };
}

export type PasswordResetResult = { ok: false } | { ok: true; tokenConsumed: boolean };

export interface PasswordResetCompletionDeps extends PasswordResetDeps {
  /** Deletes the link that was redeemed. */
  consumeResetToken: (resetToken: PasswordResetToken) => Promise<unknown>;
  /** Tells the account owner the password changed. */
  sendResetNotice: (user: PasswordResetUser) => Promise<unknown>;
}

/**
 * Redeems a reset link. Everything up to and including the password write may throw; nothing
 * after it does, so a caller that sees `ok: true` knows the password changed and owns retiring the
 * credentials it replaced. A link that could not be deleted is still spent: it predates the
 * `credentialsChangedAt` this reset stamped, which `commitPasswordReset` refuses.
 */
export async function resetPasswordWithToken(
  deps: PasswordResetCompletionDeps,
  input: PasswordResetInput,
): Promise<PasswordResetResult> {
  const outcome = await commitPasswordReset(deps, input);
  if (!outcome.ok) {
    return { ok: false };
  }

  let tokenConsumed = true;
  try {
    await deps.consumeResetToken(outcome.resetToken);
  } catch (error) {
    tokenConsumed = false;
    logger.error(
      `[resetPassword] Failed to delete the redeemed link for user ${input.userId}`,
      error,
    );
  }
  try {
    await deps.sendResetNotice(outcome.user);
  } catch (error) {
    logger.error(`[resetPassword] Failed to send the reset notice for user ${input.userId}`, error);
  }
  logger.info(`[resetPassword] Password reset successful. [User ID: ${input.userId}]`);
  return { ok: true, tokenConsumed };
}

/** Whether the link was issued before the account's last credential change, which spent it. */
export function isResetTokenSpent(
  resetToken: PasswordResetToken,
  user: PasswordResetUser | null,
): boolean {
  if (resetToken.createdAt == null || user?.credentialsChangedAt == null) {
    return false;
  }
  const issuedMs = new Date(resetToken.createdAt).getTime();
  const changedMs = new Date(user.credentialsChangedAt).getTime();
  return !Number.isNaN(issuedMs) && !Number.isNaN(changedMs) && issuedMs <= changedMs;
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

  if (!resetToken || !(await deps.compareToken(input.token, resetToken.token))) {
    return { ok: false };
  }

  if (!resetTokenBindsToAccount(resetToken, account) || !account) {
    return { ok: false };
  }
  if (isResetTokenSpent(resetToken, account)) {
    return { ok: false };
  }

  const user = await deps.updateUser(
    input.userId,
    createPasswordResetUpdate(await deps.hashPassword(input.password)),
    /** Conditioned on the cutoff it read, so two redemptions of one link cannot both commit. */
    { email: account.email, credentialsChangedAt: account.credentialsChangedAt ?? null },
  );
  if (!user) {
    return { ok: false };
  }

  await clearPendingEmailChanges(deps, input.userId);

  return { ok: true, user, resetToken };
}
