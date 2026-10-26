import { runAsSystem } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { AuthUserDocCacheMode, AuthUserDocCacheStore, CachedAuthUser } from './userDocCache';
import {
  getCachedAuthUserDoc,
  setCachedAuthUserDoc,
  buildAuthUserDocCacheKey,
  invalidateCachedAuthUserDoc,
} from './userDocCache';

/** Fields the JWT bearer path reads; the deletion fence is opt-in on the schema. */
export const JWT_USER_PROJECTION =
  '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt';

/** What a cache hit reads to prove the cached document is still the stored one. */
export const JWT_USER_FRESHNESS_PROJECTION = '_id updatedAt +agentTriggerDeletionStartedAt';

export interface JwtUserLookupDeps {
  /** Resolved by the caller, e.g. from `getAuthUserDocCacheMode()`. */
  cacheMode: AuthUserDocCacheMode;
  getUserById: (userId: string, fieldsToSelect: string) => Promise<IUser | null>;
  getCacheStore: () => AuthUserDocCacheStore;
}

export interface JwtUserLookup {
  user: IUser | CachedAuthUser | null;
  /** True when the account deletion fence is set. */
  deleting: boolean;
  /**
   * Called once the request is accepted: evicts the cached document when the caller wrote to
   * the user, otherwise caches a document that was read from the database.
   */
  remember: (userChanged: boolean) => Promise<void>;
}

const noop = async (): Promise<void> => undefined;

function toTime(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  const time = new Date(value as string | number | Date).getTime();
  return Number.isNaN(time) ? undefined : time;
}

/**
 * A cached document is served only while the stored user has the same `updatedAt` and no
 * deletion fence. Every user mutation that can change authentication or authorization bumps
 * `updatedAt`, so a document cached from a read that raced a mutation (even one published
 * after that mutation's eviction) is never served: the next hit sees the newer stamp.
 */
function isCachedDocCurrent(cached: CachedAuthUser, stored: IUser | null): boolean {
  if (!stored || stored.agentTriggerDeletionStartedAt != null) {
    return false;
  }
  return toTime(cached.updatedAt) === toTime(stored.updatedAt);
}

/**
 * Loads the user for a local JWT bearer, serving request bursts from the auth user document
 * cache when the caller's cache mode is on. A cache hit still makes one small read of the
 * stored `updatedAt` and deletion fence, replacing the full document read; when either
 * differs from the cached document, the full read runs as without the cache, so missing and
 * fenced users are told apart exactly as before.
 */
export async function loadJwtUser(userId: string, deps: JwtUserLookupDeps): Promise<JwtUserLookup> {
  const cacheKey =
    deps.cacheMode === 'on'
      ? buildAuthUserDocCacheKey({ strategy: 'jwt', subject: userId })
      : undefined;
  const store = cacheKey ? deps.getCacheStore() : undefined;

  if (store && cacheKey) {
    const cached = await getCachedAuthUserDoc(store, cacheKey);
    if (cached) {
      const stored = await runAsSystem(() =>
        deps.getUserById(userId, JWT_USER_FRESHNESS_PROJECTION),
      );
      if (isCachedDocCurrent(cached, stored)) {
        return {
          user: cached,
          deleting: false,
          remember: async (userChanged) => {
            if (userChanged) {
              await invalidateCachedAuthUserDoc(store, { userId, cacheKey });
            }
          },
        };
      }
    }
  }

  const user = await runAsSystem(() => deps.getUserById(userId, JWT_USER_PROJECTION));
  const deleting = user?.agentTriggerDeletionStartedAt != null;
  if (!user || deleting || !store || !cacheKey) {
    return { user, deleting, remember: noop };
  }
  return {
    user,
    deleting,
    remember: async (userChanged) => {
      if (userChanged) {
        await invalidateCachedAuthUserDoc(store, { userId, cacheKey });
        return;
      }
      await setCachedAuthUserDoc(store, cacheKey, user);
    },
  };
}
