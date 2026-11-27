import { randomUUID } from 'crypto';
import { Time, CacheKeys } from 'librechat-data-provider';
import type { Keyv } from 'keyv';
import { keyvRedisClient, ioredisClient } from './redisClients';
import { instrumentIORedisClient } from './redisTelemetry';
import { standardCache } from './cacheFactory';
import { cacheConfig } from './cacheConfig';
import { math } from '~/utils';

const cacheTtl = math(process.env.USER_PRINCIPALS_CACHE_TTL_MS, Time.FIVE_MINUTES);
const lockTtl = math(process.env.USER_PRINCIPALS_LOCK_TTL_MS, 5000);
const lockWait = math(process.env.USER_PRINCIPALS_LOCK_WAIT_MS, lockTtl);

export type UserPrincipalsCache = Keyv & {
  crossProcess?: boolean;
  lockWaitMs?: number;
  staleEvictionDelayMs?: number;
  acquireLock?: (key: string) => Promise<string | null>;
  releaseLock?: (key: string, token: string) => Promise<void>;
};

const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

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
  const redisClient = ioredisClient
    ? instrumentIORedisClient(ioredisClient, CacheKeys.USER_PRINCIPALS)
    : ioredisClient;
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
  }
  if (isRedisBacked && redisClient != null && lockTtl > 0) {
    cache.acquireLock = async (key) => {
      const token = randomUUID();
      const result = await redisClient.set(key, token, 'PX', lockTtl, 'NX');
      return result === 'OK' ? token : null;
    };
    cache.releaseLock = async (key, token) => {
      await redisClient.eval(releaseLockScript, 1, key, token);
    };
  }

  memoizedCache = cache;
  return cache;
}
