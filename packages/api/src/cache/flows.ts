import { randomUUID } from 'crypto';
import { Time, CacheKeys } from 'librechat-data-provider';
import type { Keyv } from 'keyv';
import { keyvRedisClient, ioredisClient } from './redisClients';
import { instrumentIORedisClient } from './redisTelemetry';
import { standardCache } from './cacheFactory';
import { cacheConfig } from './cacheConfig';

/** Lock TTL for atomic flow-completion locking (`completeFlowIfPending`). */
const LOCK_TTL_MS = 5000;

export type FlowsCache = Keyv & {
  acquireLock?: (key: string) => Promise<string | null>;
  releaseLock?: (key: string, token: string) => Promise<void>;
};

const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

let memoizedCache: FlowsCache | undefined;

/**
 * Cache for OAuth/elicitation flow state (`FlowStateManager`). When the
 * namespace is Redis-backed, lock helpers are attached so
 * `completeFlowIfPending` can atomically transition a flow across containers.
 */
export function flowsCache(): FlowsCache {
  if (memoizedCache) {
    return memoizedCache;
  }

  const cache: FlowsCache = standardCache(CacheKeys.FLOWS, Time.ONE_MINUTE * 10);
  const redisClient = ioredisClient
    ? instrumentIORedisClient(ioredisClient, CacheKeys.FLOWS)
    : ioredisClient;
  const isRedisBacked =
    keyvRedisClient != null &&
    !cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(CacheKeys.FLOWS);

  if (isRedisBacked && redisClient != null) {
    cache.acquireLock = async (key) => {
      const token = randomUUID();
      const result = await redisClient.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
      return result === 'OK' ? token : null;
    };
    cache.releaseLock = async (key, token) => {
      await redisClient.eval(releaseLockScript, 1, key, token);
    };
  }

  memoizedCache = cache;
  return cache;
}
