import { checkEmailConfig } from '~/utils';

/** Unix timestamp for 2024-06-07 15:20:18 Eastern Time, when verification became mandatory. */
export const verificationEnabledTimestamp: number = 1717788018;

/** Identifier a user document is addressed by: `_id` on a document, `id` on a serialized one. */
export type UserDocumentId = string | { toString(): string };

export interface LegacyVerificationUser {
  _id?: UserDocumentId;
  id?: string;
  emailVerified?: boolean;
  createdAt?: Date | string;
}

export interface LegacyVerificationDeps {
  updateUser: (
    userId: UserDocumentId,
    update: { emailVerified: boolean },
  ) => Promise<object | null>;
}

/**
 * Accounts created before verification was mandatory were never given a way to verify,
 * so on a deployment with no email configured they would be locked out for good. Marking
 * them verified as they sign in is the compatibility path.
 *
 * This has to apply to every login method: gating it per strategy means the same account
 * is accepted by one factor and refused by another.
 *
 * Mutates `user.emailVerified` so callers can keep reading it after the await.
 * Resolves whether the account counts as verified afterwards.
 */
export async function grandfatherLegacyEmailVerification(
  deps: LegacyVerificationDeps,
  user: LegacyVerificationUser | null | undefined,
): Promise<boolean> {
  if (user?.emailVerified) {
    return true;
  }
  if (!user || checkEmailConfig()) {
    return false;
  }

  const createdAtMs = new Date(user.createdAt ?? NaN).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  if (Math.floor(createdAtMs / 1000) >= verificationEnabledTimestamp) {
    return false;
  }

  await deps.updateUser((user._id ?? user.id) as UserDocumentId, { emailVerified: true });
  user.emailVerified = true;
  return true;
}
