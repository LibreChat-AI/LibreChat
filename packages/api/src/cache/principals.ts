import { Time, CacheKeys } from 'librechat-data-provider';
import type { LockableCache } from './lock';
import { keyvRedisClient } from './redisClients';
import { standardCache } from './cacheFactory';
import { cacheConfig } from './cacheConfig';
import { attachRedisLock } from './lock';
import { math } from '~/utils';

const cacheTtl = math(process.env.USER_PRINCIPALS_CACHE_TTL_MS, Time.FIVE_MINUTES);
const lockTtl = math(process.env.USER_PRINCIPALS_LOCK_TTL_MS, 5000);
const lockWait = math(process.env.USER_PRINCIPALS_LOCK_WAIT_MS, lockTtl);

export type UserPrincipalsCache = LockableCache & {
  crossProcess?: boolean;
  lockWaitMs?: number;
  staleEvictionDelayMs?: number;
};

let memoizedCache: UserPrincipalsCache | undefined;

/**
 * Cache for resolved group memberships used by ACL principal resolution
 * (`getUserPrincipals`). When the namespace is Redis-backed, lock helpers are
 * attached so concurrent cold-key builds are deduplicated across containers.
 * Returns undefined when disabled via USER_PRINCIPALS_CACHE_TTL_MS=0.
 */
export function userPrincipalsCache(): UserPrincipalsCache | undefined {
  if (cacheTtl <= 0) {
    return undefined;
  }
  if (memoizedCache) {
    return memoizedCache;
  }

  const cache: UserPrincipalsCache = standardCache(CacheKeys.USER_PRINCIPALS, cacheTtl);
  const isRedisBacked =
    keyvRedisClient != null &&
    !cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(CacheKeys.USER_PRINCIPALS);
  if (isRedisBacked) {
    /** Marks the store shared across containers; the delayed stale-rewrite eviction
     * pass depends on this even when build locking is disabled (lock TTL of 0). */
    cache.crossProcess = true;
    cache.lockWaitMs = Math.max(lockWait, 0);
    /** Lock wait plus one build round-trip, floored so lockless configurations
     * (lock TTL of 0) still cover multi-second builds in other containers. */
    cache.staleEvictionDelayMs = Math.max(cache.lockWaitMs + 500, 3000);
    attachRedisLock(cache, CacheKeys.USER_PRINCIPALS, lockTtl);
  }

  memoizedCache = cache;
  return cache;
}
