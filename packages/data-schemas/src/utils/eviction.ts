import {
  CacheKeys,
  AUTH_USER_DOC_BY_ID_PREFIX,
  AUTH_USER_DOC_EVICTED_PREFIX,
  AUTH_USER_DOC_EVICTION_FENCE_TTL_MS,
} from 'librechat-data-provider';
import type { CacheStore } from '~/types';
import logger from '~/config/winston';

/** Store operations eviction needs; a failure is only seen when the store throws it. */
export interface AuthUserDocEvictionStore {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
}

/** Users evicted at once by a bulk mutation. */
const EVICTION_BATCH = 100;

export function isAuthUserDocCacheEnabled(): boolean {
  return process.env.AUTH_USER_CACHE_MODE === 'on';
}

export function buildAuthUserDocEvictionFenceKey(userId: string): string {
  return `${AUTH_USER_DOC_EVICTED_PREFIX}:${userId}`;
}

/**
 * True while an eviction of the user is recent enough that a document read before it may still
 * be cached. A failed read counts as fenced, so an unreadable fence never serves a document.
 */
export async function isAuthUserDocEvictionFenced(
  store: Pick<AuthUserDocEvictionStore, 'get'>,
  userId: string,
): Promise<boolean> {
  try {
    return (await store.get(buildAuthUserDocEvictionFenceKey(userId))) != null;
  } catch (error) {
    logger.warn('[authUserDocCache] Eviction fence read failed; skipping the cached document', {
      userId,
      error: describeError(error),
    });
    return true;
  }
}

function isKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key) => typeof key === 'string');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deletes the cached auth user documents for a user, attempting every delete even when
 * another fails. A user eviction first writes a fence that outlives every document read before
 * it: a request that looked the user up before the change cannot cache or serve that document,
 * including one the reverse index never named. Resolves false when any step failed (the fence
 * write, the index read, so its keys are unknown, or a document delete), so a caller that must
 * prove the eviction stays conservative. The index is deleted only
 * after every document it names is gone, so a retry can still find what an earlier attempt
 * left behind. A failed delete of the index alone leaves only the names of deleted keys, so it
 * is logged and still counts as evicted. Never throws, so callers keep their own write results.
 */
export async function evictAuthUserDocs(
  store: AuthUserDocEvictionStore,
  input: { userId?: string; cacheKey?: string },
): Promise<boolean> {
  const keys = new Set<string>(input.cacheKey ? [input.cacheKey] : []);
  const indexKey = input.userId ? `${AUTH_USER_DOC_BY_ID_PREFIX}:${input.userId}` : undefined;
  let fenced = true;
  let indexRead = true;
  if (input.userId) {
    try {
      await store.set(
        buildAuthUserDocEvictionFenceKey(input.userId),
        Date.now(),
        AUTH_USER_DOC_EVICTION_FENCE_TTL_MS,
      );
    } catch (error) {
      fenced = false;
      logger.warn('[authUserDocCache] Eviction fence write failed', {
        userId: input.userId,
        error: describeError(error),
      });
    }
  }
  if (indexKey) {
    try {
      const indexed = await store.get(indexKey);
      if (indexed != null && !isKeyList(indexed)) {
        throw new Error('Reverse index is not a list of cache keys');
      }
      for (const key of indexed ?? []) {
        keys.add(key);
      }
    } catch (error) {
      indexRead = false;
      logger.warn('[authUserDocCache] Reverse index read failed during eviction', {
        userId: input.userId,
        error: describeError(error),
      });
    }
  }

  const results = await Promise.allSettled([...keys].map((key) => store.delete(key)));
  let documentsDeleted = true;
  for (const result of results) {
    if (result.status === 'rejected') {
      documentsDeleted = false;
      logger.warn('[authUserDocCache] Cached document delete failed during eviction', {
        userId: input.userId,
        error: describeError(result.reason),
      });
    }
  }
  if (!fenced || !indexRead || !documentsDeleted) {
    return false;
  }

  if (indexKey) {
    try {
      await store.delete(indexKey);
    } catch (error) {
      logger.warn('[authUserDocCache] Reverse index delete failed during eviction', {
        userId: input.userId,
        error: describeError(error),
      });
    }
  }
  return true;
}

/**
 * Evicts the cached auth user documents of every listed user, a batch at a time. Resolves true
 * when the cache is off or absent, and false when any user's documents may still be served.
 */
export async function evictAuthUserDocsForUsers(
  getCache: ((key: string) => CacheStore | undefined) | undefined,
  userIds: Iterable<string | { toString(): string }>,
): Promise<boolean> {
  if (!isAuthUserDocCacheEnabled()) {
    return true;
  }
  const cache = getCache?.(CacheKeys.AUTH_USER_DOC);
  if (!cache?.get) {
    return true;
  }
  const remove = cache.delete?.bind(cache);
  if (!remove) {
    return false;
  }
  const store: AuthUserDocEvictionStore = {
    get: (key) => cache.get(key),
    set: (key, value, ttl) => cache.set(key, value, ttl),
    delete: remove,
  };
  const ids = [...new Set([...userIds].map((userId) => userId.toString()))];
  let evicted = true;
  for (let start = 0; start < ids.length; start += EVICTION_BATCH) {
    const results = await Promise.all(
      ids
        .slice(start, start + EVICTION_BATCH)
        .map((userId) => evictAuthUserDocs(store, { userId })),
    );
    evicted = evicted && results.every(Boolean);
  }
  return evicted;
}
