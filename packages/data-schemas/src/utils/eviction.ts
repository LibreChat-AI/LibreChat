import { AUTH_USER_DOC_BY_ID_PREFIX } from 'librechat-data-provider';
import logger from '~/config/winston';

/** Store operations eviction needs; a failure is only seen when the store throws it. */
export interface AuthUserDocEvictionStore {
  get: (key: string) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Deletes the cached auth user documents for a user, attempting every delete even when
 * another fails. Resolves false when a document may still be served: the reverse index could
 * not be read, so its keys are unknown, or a document delete failed. A failed delete of the
 * index alone leaves only the names of deleted keys behind, so it is logged and still counts
 * as evicted. Never throws, so callers keep their own write results.
 */
export async function evictAuthUserDocs(
  store: AuthUserDocEvictionStore,
  input: { userId?: string; cacheKey?: string },
): Promise<boolean> {
  const keys = new Set<string>(input.cacheKey ? [input.cacheKey] : []);
  const indexKey = input.userId ? `${AUTH_USER_DOC_BY_ID_PREFIX}:${input.userId}` : undefined;
  let indexRead = true;
  if (indexKey) {
    try {
      const indexed = await store.get(indexKey);
      if (Array.isArray(indexed)) {
        for (const key of indexed) {
          if (typeof key === 'string') {
            keys.add(key);
          }
        }
      }
    } catch (error) {
      indexRead = false;
      logger.warn('[authUserDocCache] Reverse index read failed during eviction', {
        userId: input.userId,
        error: describeError(error),
      });
    }
  }

  const documentKeys = [...keys];
  const results = await Promise.allSettled(
    [...documentKeys, ...(indexKey ? [indexKey] : [])].map((key) => store.delete(key)),
  );
  let documentsDeleted = true;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      return;
    }
    const isIndex = index >= documentKeys.length;
    documentsDeleted = documentsDeleted && isIndex;
    logger.warn(
      isIndex
        ? '[authUserDocCache] Reverse index delete failed during eviction'
        : '[authUserDocCache] Cached document delete failed during eviction',
      { userId: input.userId, error: describeError(result.reason) },
    );
  });

  return indexRead && documentsDeleted;
}
