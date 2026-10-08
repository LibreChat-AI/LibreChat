import type { LogArgument } from './types';

export const OPENID_REFRESH_OWNERSHIP_LOST = 'OPENID_REFRESH_OWNERSHIP_LOST';
export const OPENID_REFRESH_CANCELLED_BEFORE_GRANT = 'OPENID_REFRESH_CANCELLED_BEFORE_GRANT';

/** Express-session uses this exact error when reload cannot find the persisted session. */
export function isOpenIDSessionMissingError(error: unknown): boolean {
  return error instanceof Error && error.message === 'failed to load session';
}

/**
 * Reloads the persisted Express session before a publication decision. express-session rejects with
 * `failed to load session` when the record is merely absent — the session-store TTL elapsed, the
 * entry was evicted, or a logout in another replica removed it — which describes an empty session
 * rather than one that advanced past this result. Tolerate that case so a refresh backed by a
 * still-valid refresh token seeds a new record instead of demanding an interactive sign-in, and let
 * every other store failure (an outage) propagate to the caller.
 *
 * Logout safety does not depend on this record: `revokeOpenIDRefreshTokenChain` writes a durable
 * revoked publication flight for every refresh token it retires, so a retired token still fails.
 *
 * @returns `true` when the persisted record was read, `false` when it was gone.
 */
export async function reloadOpenIDSessionIfPersisted(
  session?: { reload?: (callback: (error?: Error | null) => void) => void } | null,
): Promise<boolean> {
  if (typeof session?.reload !== 'function') {
    return false;
  }
  const reload = session.reload.bind(session);
  try {
    await new Promise<void>((resolve, reject) => {
      reload((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    return true;
  } catch (error) {
    if (isOpenIDSessionMissingError(error)) {
      return false;
    }
    throw error;
  }
}

export function toOpenIDLogArgument(error: unknown): LogArgument {
  return error instanceof Error ? error : String(error);
}

/**
 * Marks the one failure mode that proves another worker owns this refresh: the coordination
 * record is no longer pending under our owner id. Callers that compensate a published side
 * effect must distinguish it from a transient coordination read failure, where ownership is
 * merely unknown and the side effect is still the caller's only usable credential.
 */
export function createOpenIDRefreshOwnershipError(message: string): Error {
  return Object.assign(new Error(message), { code: OPENID_REFRESH_OWNERSHIP_LOST });
}

export function isOpenIDRefreshOwnershipError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === OPENID_REFRESH_OWNERSHIP_LOST
  );
}
