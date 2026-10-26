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

export interface JwtUserLookupDeps {
  /** Resolved by the caller, e.g. from `getAuthUserDocCacheMode()`. */
  cacheMode: AuthUserDocCacheMode;
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
 * Caches a document read from the database, then reads it again: a user mutation that
 * committed after the first read may already have run its eviction, so the write just made
 * would serve the old document. When the second read differs, or fails, the entry is evicted.
 * A mutation committing after the second read evicts the written entry itself.
 */
async function cacheUnlessChanged(
  store: AuthUserDocCacheStore,
  cacheKey: string,
  userId: string,
  user: IUser,
  snapshot: string,
  getUserById: JwtUserLookupDeps['getUserById'],
): Promise<void> {
  await setCachedAuthUserDoc(store, cacheKey, user);
  let current: IUser | null = null;
  try {
    current = await runAsSystem(() => getUserById(userId, JWT_USER_PROJECTION));
  } catch {
    current = null;
  }
  if (!current || JSON.stringify(current) !== snapshot) {
    await invalidateCachedAuthUserDoc(store, { userId, cacheKey });
  }
}

/**
 * Loads the user for a local JWT bearer, serving request bursts from the auth user document
 * cache when the caller's cache mode is on. Every user mutation evicts that cache through the
 * reverse index, and a cache hit still reads the deletion fence fresh; a hit whose principal is
 * no longer active falls back to the database read, so missing users and fenced users are told
 * apart exactly as without the cache.
 */
export async function loadJwtUser(userId: string, deps: JwtUserLookupDeps): Promise<JwtUserLookup> {
  const cacheKey =
    deps.cacheMode === 'on'
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
  /** Taken before the caller decorates the document for `req.user`. */
  const snapshot = JSON.stringify(user);
  return {
    user,
    deleting,
    remember: async (userChanged) => {
      if (userChanged) {
        await invalidateCachedAuthUserDoc(store, { userId, cacheKey });
        return;
      }
      await cacheUnlessChanged(store, cacheKey, userId, user, snapshot, deps.getUserById);
    },
  };
}
