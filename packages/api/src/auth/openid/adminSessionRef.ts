import { createHash } from 'node:crypto';
import type { Keyv } from 'keyv';
import type { OpenIDLogger } from './types';
import { createOpenIDSessionAuthorizationUnavailableError } from './sessions/authorize';

export interface AdminOpenIDSessionRefDeps {
  cache: Keyv;
  logger: Pick<OpenIDLogger, 'warn'>;
}

export interface AdminOpenIDSessionRefOptions {
  /** On, a cache error throws the unavailable error instead of logging and continuing. */
  enforcement?: boolean;
  ttlMs?: number;
}

function adminOpenIDSessionRefKey(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

async function recoverOrThrow(
  deps: AdminOpenIDSessionRefDeps,
  options: AdminOpenIDSessionRefOptions,
  message: string,
  error: unknown,
): Promise<void> {
  if (options.enforcement) {
    throw createOpenIDSessionAuthorizationUnavailableError();
  }
  deps.logger.warn(message, error as Error);
}

/** The admin bearer flow has no Session document; this cache is where its OpenID session
 *  reference lives, keyed by a hash of the refresh token rather than the token itself. */
export async function rememberAdminOpenIDSessionRef(
  deps: AdminOpenIDSessionRefDeps,
  refreshToken: string | undefined,
  openidSessionId: string | undefined,
  options: AdminOpenIDSessionRefOptions = {},
): Promise<void> {
  if (!refreshToken || !openidSessionId) {
    return;
  }
  try {
    await deps.cache.set(adminOpenIDSessionRefKey(refreshToken), openidSessionId, options.ttlMs);
  } catch (err) {
    await recoverOrThrow(
      deps,
      options,
      '[AdminOpenIDSessionRef] Failed to remember the OpenID session reference',
      err,
    );
  }
}

export async function recallAdminOpenIDSessionRef(
  deps: AdminOpenIDSessionRefDeps,
  refreshToken: string | undefined,
  options: AdminOpenIDSessionRefOptions = {},
): Promise<string | undefined> {
  if (!refreshToken) {
    return undefined;
  }
  try {
    return await deps.cache.get<string>(adminOpenIDSessionRefKey(refreshToken));
  } catch (err) {
    await recoverOrThrow(
      deps,
      options,
      '[AdminOpenIDSessionRef] Failed to recall the OpenID session reference',
      err,
    );
    return undefined;
  }
}

/** Carries the reference forward across a rotated refresh token; a no-op without one. Writes
 *  the new reference before deleting the old one, so a failed delete only leaves a stale key
 *  that expires on its TTL rather than losing the reference. */
export async function rotateAdminOpenIDSessionRef(
  deps: AdminOpenIDSessionRefDeps,
  oldRefreshToken: string | undefined,
  newRefreshToken: string | undefined,
  openidSessionId: string | undefined,
  options: AdminOpenIDSessionRefOptions = {},
): Promise<void> {
  await rememberAdminOpenIDSessionRef(
    deps,
    newRefreshToken ?? oldRefreshToken,
    openidSessionId,
    options,
  );
  if (oldRefreshToken && newRefreshToken && newRefreshToken !== oldRefreshToken) {
    try {
      await deps.cache.delete(adminOpenIDSessionRefKey(oldRefreshToken));
    } catch (err) {
      deps.logger.warn(
        '[AdminOpenIDSessionRef] Failed to delete the rotated OpenID session reference; it expires on its TTL',
        err as Error,
      );
    }
  }
}
