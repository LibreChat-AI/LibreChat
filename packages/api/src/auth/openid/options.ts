import type { ProviderSessionRef } from 'librechat-data-provider';

/** Accepted by `setOpenIDAuthTokens` either as its 4th argument, or synthesized from the legacy
 *  positional form `(userId, existingRefreshToken, tenantId)`. */
export interface OpenIDAuthTokenOptions {
  userId?: string | null;
  existingRefreshToken?: string;
  tenantId?: string;
  openidSubject?: string;
  openidIssuer?: string;
  /** The provider session this credential is bound to. */
  providerSession?: ProviderSessionRef | null;
}

/**
 * `setOpenIDAuthTokens` accepts either an options object (`{ userId, tenantId, ... }`) or its
 * legacy positional form `(userId, existingRefreshToken, tenantId)`. An object is recognized as
 * the options form by carrying at least one of the known option keys; an object with none of
 * them, a bare string, `null`, or `undefined` is treated as the positional `userId` and wrapped
 * accordingly.
 */
export function resolveOpenIDAuthTokenOptions(
  optionsOrUserId: OpenIDAuthTokenOptions | string | null | undefined,
  existingRefreshToken?: string,
  tenantId?: string,
): OpenIDAuthTokenOptions {
  if (optionsOrUserId != null && typeof optionsOrUserId === 'object') {
    if (
      'userId' in optionsOrUserId ||
      'existingRefreshToken' in optionsOrUserId ||
      'tenantId' in optionsOrUserId ||
      'openidSubject' in optionsOrUserId ||
      'openidIssuer' in optionsOrUserId ||
      'providerSession' in optionsOrUserId
    ) {
      return optionsOrUserId;
    }
    return {};
  }

  return { userId: optionsOrUserId, existingRefreshToken, tenantId };
}
