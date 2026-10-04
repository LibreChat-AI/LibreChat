import { randomUUID } from 'crypto';
import type { Keyv } from 'keyv';
import { keyvRedisClient, ioredisClient } from './redisClients';
import { instrumentIORedisClient } from './redisTelemetry';
import { cacheConfig } from './cacheConfig';

/**
 * A cache namespace that can also hand out a short-lived exclusive claim.
 * The helpers are optional because they are only attached to a Redis-backed
 * namespace: an in-memory namespace is private to the process that created
 * it, so there is no second holder to coordinate with and a caller's own
 * in-process serialization is already sufficient.
 */
export type LockableCache = Keyv & {
  acquireLock?: (key: string) => Promise<string | null>;
  extendLock?: (key: string, token: string) => Promise<boolean>;
  releaseLock?: (key: string, token: string) => Promise<void>;
  setIfLockOwned?: <Value>(
    lockKey: string,
    key: string,
    token: string,
    value: Value,
    ttl: number,
  ) => Promise<boolean>;
  lockTtl?: number;
};

/**
 * Deletes the lock only while this caller still owns it. A holder whose work
 * outran the lock TTL must not delete the claim a later holder has since
 * taken, so the token is compared and deleted in one Redis round trip.
 */
const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const extendLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const setIfLockOwnedScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`;

/**
 * Attaches `SET NX PX` claim helpers to a cache namespace, giving callers the
 * one atomic primitive `Keyv` itself lacks: its `get`/`set` pair cannot be
 * made exclusive across containers, so every read-modify-write over a shared
 * namespace is otherwise racy between replicas.
 *
 * A no-op unless the namespace is genuinely Redis-backed, which keeps the
 * in-memory fallback on exactly the behavior it had before.
 *
 * @param cache - The namespace to extend, mutated and returned.
 * @param namespace - Used for Redis telemetry attribution.
 * @param lockTtl - Claim lifetime in ms; a value of 0 or less disables locking.
 */
export function attachRedisLock<T extends Keyv>(
  cache: T,
  namespace: string,
  lockTtl: number,
): T & LockableCache {
  const lockable = cache as T & LockableCache;
  const isRedisBacked =
    keyvRedisClient != null && !cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(namespace);
  if (!isRedisBacked || ioredisClient == null || lockTtl <= 0) {
    return lockable;
  }

  const redisClient = instrumentIORedisClient(ioredisClient, namespace);
  lockable.acquireLock = async (key) => {
    const token = randomUUID();
    const result = await redisClient.set(key, token, 'PX', lockTtl, 'NX');
    return result === 'OK' ? token : null;
  };
  lockable.extendLock = async (key, token) => {
    const result = await redisClient.eval(extendLockScript, 1, key, token, lockTtl);
    return result === 1;
  };
  lockable.releaseLock = async (key, token) => {
    await redisClient.eval(releaseLockScript, 1, key, token);
  };
  lockable.setIfLockOwned = async (lockKey, key, token, value, ttl) => {
    if (!cache.serialize) {
      throw new Error(`Cache namespace ${namespace} cannot serialize an atomic write`);
    }
    const serialized = await cache.serialize({ value, expires: Date.now() + ttl });
    const result = await redisClient.eval(
      setIfLockOwnedScript,
      2,
      lockKey,
      `${namespace}:${key}`,
      token,
      serialized,
      ttl,
    );
    return result === 1;
  };
  lockable.lockTtl = lockTtl;
  return lockable;
}
