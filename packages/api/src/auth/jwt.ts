import { runAsSystem } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { AuthUserDocCacheMode, AuthUserDocCacheStore, CachedAuthUser } from './userDocCache';
import {
  timeAuthUserLookup,
  setCachedAuthUserDoc,
  getCurrentCachedAuthUserDoc,
  buildAuthUserDocCacheKey,
  invalidateCachedAuthUserDoc,
} from './userDocCache';

/** Fields the JWT bearer path reads; the deletion fence is opt-in on the schema. */
export const JWT_USER_PROJECTION =
  '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt';

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
    const cached = await getCurrentCachedAuthUserDoc(store, cacheKey, {
      findUser: ({ _id }, fields) => runAsSystem(() => deps.getUserById(_id, fields)),
    });
    if (cached) {
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

  /** Stamped before the read so a lookup that overlaps an eviction is never cached past it. */
  const { result: user, lookupStartedAt } = await timeAuthUserLookup(() =>
    runAsSystem(() => deps.getUserById(userId, JWT_USER_PROJECTION)),
  );
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
      await setCachedAuthUserDoc(store, cacheKey, user, lookupStartedAt);
    },
  };
}
