import { runAsSystem } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { AuthUserDocCacheStore, CachedAuthUser } from './userDocCache';
import {
  getCachedAuthUserDoc,
  setCachedAuthUserDoc,
  buildAuthUserDocCacheKey,
  getAuthUserDocCacheMode,
  invalidateCachedAuthUserDoc,
} from './userDocCache';

/** Fields the JWT bearer path reads; the deletion fence is opt-in on the schema. */
export const JWT_USER_PROJECTION =
  '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt';

export interface JwtUserLookupDeps {
  getUserById: (userId: string, fieldsToSelect: string) => Promise<IUser | null>;
  /** Fresh fence read, so a cached document never outlives an account deletion. */
  isPrincipalActive: (userId: string) => Promise<boolean>;
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

/**
 * Loads the user for a local JWT bearer, serving request bursts from the auth user document
 * cache when `AUTH_USER_CACHE_MODE` is on. Every user mutation evicts that cache through the
 * reverse index, and a cache hit still reads the deletion fence fresh; a hit whose principal is
 * no longer active falls back to the database read, so missing users and fenced users are told
 * apart exactly as without the cache.
 */
export async function loadJwtUser(userId: string, deps: JwtUserLookupDeps): Promise<JwtUserLookup> {
  const cacheKey =
    getAuthUserDocCacheMode() === 'on'
      ? buildAuthUserDocCacheKey({ strategy: 'jwt', subject: userId })
      : undefined;
  const store = cacheKey ? deps.getCacheStore() : undefined;

  if (store && cacheKey) {
    const cached = await getCachedAuthUserDoc(store, cacheKey);
    if (cached && (await runAsSystem(() => deps.isPrincipalActive(userId)))) {
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
