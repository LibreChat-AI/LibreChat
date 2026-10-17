import { randomUUID } from 'node:crypto';
import type { Redis, Cluster } from 'ioredis';
import type { RedisScriptClient } from './redisScript';
import { evalScript } from './redisScript';

export type DistributedLock = {
  /** Claims `key` for `ttlMs`. Returns an owner token, or null when another owner holds it. Throws `RangeError` when `ttlMs` is not a positive integer. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /** Pushes the expiry of a lock this token owns. False when the lock is gone or owned by someone else. Throws `RangeError` when `ttlMs` is not a positive integer. */
  extend(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Releases only if this token still owns the lock. False means the lease already expired before this call, so the key was gone or held by a different token; true means this call deleted it. */
  release(key: string, token: string): Promise<boolean>;
};

export type DistributedLockRedisClient = RedisScriptClient & Pick<Redis | Cluster, 'set'>;

export type CreateDistributedLockOptions = {
  /** When present the lock is shared across processes. When absent an in-process lock is used. */
  redisClient?: DistributedLockRedisClient | null;
  /** Injectable clock for the in-process path (tests). */
  now?: () => number;
};

const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const SWEEP_MIN_SIZE = 64;

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`ttlMs must be a positive integer, got ${ttlMs}`);
  }
}

function createRedisLock(redisClient: DistributedLockRedisClient): DistributedLock {
  return {
    async acquire(key, ttlMs) {
      assertTtl(ttlMs);
      const token = randomUUID();
      const result = await redisClient.set(key, token, 'PX', ttlMs, 'NX');
      return result === 'OK' ? token : null;
    },
    async extend(key, token, ttlMs) {
      assertTtl(ttlMs);
      const result = await evalScript(redisClient, EXTEND_SCRIPT, 1, key, token, ttlMs);
      return Number(result) === 1;
    },
    async release(key, token) {
      const result = await evalScript(redisClient, RELEASE_SCRIPT, 1, key, token);
      return Number(result) === 1;
    },
  };
}

function createInProcessLock(now: () => number): DistributedLock {
  const locks = new Map<string, { token: string; expiresAt: number }>();
  let sweepAt = SWEEP_MIN_SIZE;
  function evictExpired(): void {
    const currentTime = now();
    for (const [key, entry] of locks) {
      if (entry.expiresAt <= currentTime) {
        locks.delete(key);
      }
    }
  }
  return {
    async acquire(key, ttlMs) {
      assertTtl(ttlMs);
      // Sweeping on every call would make acquire O(n) in the table size. Instead the
      // sweep runs only once the table has grown past a size-tracking threshold, so
      // acquire stays amortized O(1) while expired keys that are never touched again
      // still get reclaimed.
      if (locks.size >= sweepAt) {
        evictExpired();
        sweepAt = Math.max(SWEEP_MIN_SIZE, locks.size * 2);
      }
      const existing = locks.get(key);
      if (existing && existing.expiresAt > now()) {
        return null;
      }
      const token = randomUUID();
      locks.set(key, { token, expiresAt: now() + ttlMs });
      return token;
    },
    async extend(key, token, ttlMs) {
      assertTtl(ttlMs);
      const existing = locks.get(key);
      if (existing && existing.expiresAt <= now()) {
        locks.delete(key);
        return false;
      }
      if (!existing || existing.token !== token) {
        return false;
      }
      existing.expiresAt = now() + ttlMs;
      return true;
    },
    async release(key, token) {
      const existing = locks.get(key);
      if (existing && existing.expiresAt <= now()) {
        locks.delete(key);
        return false;
      }
      if (existing && existing.token === token) {
        locks.delete(key);
        return true;
      }
      return false;
    },
  };
}

/**
 * Creates a `DistributedLock` for coordinating a critical section across callers.
 *
 * The Redis client is a caller-supplied dependency rather than an imported
 * singleton (`ioredisClient`), so callers can instrument or mock it.
 *
 * The in-process lock coordinates only inside one process. Multi-node
 * deployments must pass a Redis client; LibreChat already requires shared
 * Redis for multi-replica features (see `.env.example`, scheduled chats).
 *
 * Each instance owns its own key namespace: callers that must exclude each
 * other share one `DistributedLock` instance, the same way they share the
 * Redis client. Two instances created without a Redis client do not
 * coordinate.
 */
export function createDistributedLock(options: CreateDistributedLockOptions = {}): DistributedLock {
  const { redisClient, now = Date.now } = options;
  if (redisClient != null) {
    return createRedisLock(redisClient);
  }
  return createInProcessLock(now);
}
