/**
 * @keyv/redis exports its default class in a non-standard way:
 * module.exports = { default: KeyvRedis, ... } instead of module.exports = KeyvRedis
 * This breaks ES6 imports when the module is marked as external in rollup.
 * We must use require() to access the .default property directly.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KeyvRedis = require('@keyv/redis').default as typeof import('@keyv/redis').default;
import { Keyv } from 'keyv';
import createMemoryStore from 'memorystore';
import { RedisStore } from 'rate-limit-redis';
import { logger } from '@librechat/data-schemas';
import session, { MemoryStore } from 'express-session';
import { Time, CacheKeys } from 'librechat-data-provider';
import { RedisStore as ConnectRedis } from 'connect-redis';
import type { SendCommandFn } from 'rate-limit-redis';
import { keyvRedisClient, ioredisClient, handleKeyvRedisError } from './redisClients';
import { createClusterSafeSendCommand } from './limiterSendCommand';
import { batchDeleteKeys, scanKeys } from './redisUtils';
import {
  instrumentIORedisClient,
  instrumentRedisCache,
  observeRedisOperation,
  RedisUseCases,
} from './redisTelemetry';
import { cacheConfig } from './cacheConfig';
import { violationFile } from './keyvFiles';

/**
 * Memoized in-memory Keyv instances keyed by namespace.
 * Without Redis, each `new Keyv()` gets its own internal Map, so callers that
 * write in one call-site and read in another would see an empty store.
 * Memoizing ensures a single shared Map per namespace across the entire bundle.
 *
 * Only applies to the plain in-memory path (no Redis, no custom fallbackStore).
 */
const inMemoryCacheMap = new Map<string, Keyv>();

/**
 * Each Redis adapter attaches listeners to the process-wide client. Reuse it for
 * identical inputs so request-time lookups do not retain a new adapter forever.
 * TTL remains part of the identity: Redis callers can share keys while using
 * different default expirations. Custom fallback stores are ignored in Redis mode.
 */
const redisCacheMap = new Map<string, Map<number | undefined, Keyv>>();

/**
 * Deletes every key under a namespace through the raw client, which is the one
 * write path that bypasses the Keyv error funnel; READONLY rejections are routed
 * to failover recovery before propagating.
 */
async function clearRedisNamespace(namespace: string): Promise<void> {
  if (!keyvRedisClient || !('scanIterator' in keyvRedisClient)) {
    logger.warn(`Cannot clear namespace ${namespace}: Redis scanIterator not available`);
    return;
  }

  const pattern = cacheConfig.REDIS_KEY_PREFIX
    ? `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}${namespace}:*`
    : `${namespace}:*`;

  try {
    const keysToDelete = await scanKeys(keyvRedisClient, pattern);
    if (keysToDelete.length === 0) {
      return;
    }
    await batchDeleteKeys(keyvRedisClient, keysToDelete);
    logger.debug(`Cleared ${keysToDelete.length} keys from namespace ${namespace}`);
  } catch (error) {
    handleKeyvRedisError(error);
    throw error;
  }
}

/**
 * Creates a cache instance using Redis or a fallback store. Suitable for general caching needs.
 *
 * **In-memory mode** (no Redis, no custom fallbackStore): instances are memoized by
 * namespace so that every call-site shares the same underlying `Map`. The first
 * caller's TTL wins for a given namespace.
 *
 * **Redis mode**: instances are shared for the same namespace and default TTL.
 * Different TTLs still address the same Redis keys without changing one another's defaults.
 *
 * @param namespace - The cache namespace.
 * @param ttl - Time to live for cache entries.
 * @param fallbackStore - Optional fallback store if Redis is not used.
 * @returns Cache instance.
 */
export const standardCache = (namespace: string, ttl?: number, fallbackStore?: object): Keyv => {
  if (keyvRedisClient && !cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(namespace)) {
    const byTtl = redisCacheMap.get(namespace);
    const existing = byTtl?.get(ttl);
    if (existing) {
      return existing;
    }
    try {
      const keyvRedis = new KeyvRedis(keyvRedisClient);
      const cache = new Keyv(keyvRedis, { namespace, ttl });
      keyvRedis.namespace = cacheConfig.REDIS_KEY_PREFIX;
      keyvRedis.keyPrefixSeparator = cacheConfig.GLOBAL_PREFIX_SEPARATOR;

      cache.on('error', (err) => {
        logger.error(`Cache error in namespace ${namespace}:`, err);
        handleKeyvRedisError(err);
      });

      // Override clear() to handle namespace-aware deletion
      // The default Keyv clear() doesn't respect namespace due to the workaround above
      // Workaround for issue #10487 https://github.com/danny-avila/LibreChat/issues/10487
      cache.clear = () => clearRedisNamespace(namespace);

      const instrumented = instrumentRedisCache(cache, namespace);
      const instances = byTtl ?? new Map<number | undefined, Keyv>();
      instances.set(ttl, instrumented);
      redisCacheMap.set(namespace, instances);
      return instrumented;
    } catch (err) {
      logger.error(`Failed to create Redis cache for namespace ${namespace}:`, err);
      throw err;
    }
  }
  if (fallbackStore) {
    return new Keyv({ store: fallbackStore, namespace, ttl });
  }
  const existing = inMemoryCacheMap.get(namespace);
  if (existing) {
    return existing;
  }
  /** The default serializer's Buffer-aware reviver costs ~8x a plain JSON round trip on
   *  every read, and an instrumented sweep of the e2e suite found no namespace ever caching
   *  a Buffer. Plain JSON keeps today's copy semantics (readers never share references with
   *  the store, dates still come back as ISO strings); a Buffer would now round-trip as its
   *  `{ type: 'Buffer', data }` JSON form instead of reviving. */
  const cache = new Keyv({ namespace, ttl, serialize: JSON.stringify, deserialize: JSON.parse });
  inMemoryCacheMap.set(namespace, cache);
  return cache;
};

/** Convenience accessor for the TOKEN_CONFIG cache namespace. */
export const tokenConfigCache = (): Keyv =>
  standardCache(CacheKeys.TOKEN_CONFIG, Time.THIRTY_MINUTES);

/**
 * Creates a cache instance for storing violation data.
 * Uses a file-based fallback store if Redis is not enabled.
 * @param namespace - The cache namespace for violations.
 * @param ttl - Time to live for cache entries. Defaults to `cacheConfig.VIOLATION_SCORE_TTL`
 * so violation scores decay instead of accumulating forever; each write restarts the countdown.
 * @returns Cache instance for violations.
 */
export const violationCache = (
  namespace: string,
  ttl: number | undefined = cacheConfig.VIOLATION_SCORE_TTL,
): Keyv => {
  return standardCache(`violations:${namespace}`, ttl, violationFile);
};

/**
 * Creates a session cache instance using Redis or in-memory store.
 * @param namespace - The session namespace.
 * @param ttl - Time to live for session entries.
 * @returns Session store instance.
 */
export const sessionCache = (namespace: string, ttl?: number): MemoryStore | ConnectRedis => {
  namespace = namespace.endsWith(':') ? namespace : `${namespace}:`;
  if (!cacheConfig.USE_REDIS) {
    const MemoryStore = createMemoryStore(session);
    return new MemoryStore({ ttl, checkPeriod: Time.ONE_DAY });
  }
  const redisClient = ioredisClient
    ? instrumentIORedisClient(ioredisClient, namespace)
    : ioredisClient;
  const store = new ConnectRedis({ client: redisClient, ttl, prefix: namespace });
  if (ioredisClient) {
    ioredisClient.on('error', (err) => {
      logger.error(`Session store Redis error for namespace ${namespace}:`, err);
    });
  }
  return store;
};

/**
 * Creates a rate limiter cache using Redis.
 * @param prefix - The key prefix for rate limiting.
 * @returns RedisStore instance or undefined if Redis is not used.
 */
export const limiterCache = (prefix: string): RedisStore | undefined => {
  if (!prefix) {
    throw new Error('prefix is required');
  }
  if (!cacheConfig.USE_REDIS) {
    return undefined;
  }
  // rate-limit-redis supplies uppercase command names to `call()`. In the
  // pinned ioredis version, dynamic-command key metadata is case-sensitive,
  // so those calls bypass the configured keyPrefix, including EVALSHA keys.
  // Include the deployment prefix here exactly once.
  prefix = prefix.endsWith(':') ? prefix : `${prefix}:`;
  const deploymentPrefix = cacheConfig.REDIS_KEY_PREFIX
    ? `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}`
    : '';
  const limiterPrefix = `${deploymentPrefix}${prefix}`;

  try {
    const executeCommand = (async (...args: string[]) => {
      const redisClient = ioredisClient;
      if (redisClient == null) {
        throw new Error('Redis client not available');
      }
      return await observeRedisOperation('ioredis', RedisUseCases.RATE_LIMIT, args[0], () =>
        redisClient.call(args[0], ...args.slice(1)),
      );
    }) as SendCommandFn;
    const clusterSafeCommand = createClusterSafeSendCommand(executeCommand);
    const sendCommand: SendCommandFn = async (...args: string[]) => {
      try {
        return await clusterSafeCommand(...args);
      } catch (err) {
        logger.error('Redis command execution failed:', err);
        throw err;
      }
    };
    return new RedisStore({ sendCommand, prefix: limiterPrefix });
  } catch (err) {
    logger.error(`Failed to create Redis rate limiter for prefix ${prefix}:`, err);
    return undefined;
  }
};
