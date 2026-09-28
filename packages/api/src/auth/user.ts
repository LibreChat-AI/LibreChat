import type { IUser } from '@librechat/data-schemas';

/**
 * Everything an authentication response may say about a user.
 *
 * An allowlist rather than a denylist, because the queries behind these responses do not reliably
 * project: a `select()` built only from `+field` tokens leaves Mongoose with no projection to send,
 * so the full stored document comes back, secrets and session records included. Subtracting known
 * secrets from that would silently leak every field added to the schema afterwards.
 */
export const PUBLIC_USER_RESPONSE_FIELDS = [
  '_id',
  'id',
  'name',
  'username',
  'email',
  'emailVerified',
  'avatar',
  'provider',
  'role',
  'plugins',
  'twoFactorEnabled',
  'termsAccepted',
  'personalization',
  'favorites',
  'skillStates',
  'createdAt',
  'updatedAt',
  'tenantId',
] as const;

type PublicUserField = (typeof PUBLIC_USER_RESPONSE_FIELDS)[number];
export type PublicUser = Partial<Record<PublicUserField, unknown>>;

interface HydratedUser {
  toObject?: () => Record<string, unknown>;
}

/** Reduces a user document, hydrated or lean, to the fields a client is allowed to receive. */
export function sanitizeUserForResponse(user: IUser | HydratedUser | null | undefined): PublicUser {
  if (user == null) {
    return {};
  }

  const source = (
    typeof (user as HydratedUser).toObject === 'function'
      ? (user as HydratedUser).toObject?.()
      : user
  ) as Record<string, unknown>;

  const publicUser: PublicUser = {};
  for (const field of PUBLIC_USER_RESPONSE_FIELDS) {
    if (source[field] !== undefined) {
      publicUser[field] = source[field];
    }
  }

  return publicUser;
}
