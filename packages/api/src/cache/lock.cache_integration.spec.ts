import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RedisTestClient } from '../stream/__tests__/helpers/redis';
import type { DistributedLock } from './lock';
import { createRedisTestClient } from '../stream/__tests__/helpers/redis';
import { createDistributedLock } from './lock';

const describeRedis = process.env.USE_REDIS === 'true' ? describe : describe.skip;

describeRedis('createDistributedLock (real Redis)', () => {
  const keyPrefix = `DistributedLock-Integration-Test:${randomUUID()}:`;
  const key = 'lock';
  let redis: RedisTestClient;
  let otherRedis: RedisTestClient;
  let lock: DistributedLock;
  let otherLock: DistributedLock;

  beforeAll(async () => {
    redis = createRedisTestClient(keyPrefix);
    otherRedis = createRedisTestClient(keyPrefix);
    await Promise.all([redis.connect(), otherRedis.connect()]);
    lock = createDistributedLock({ redisClient: redis });
    otherLock = createDistributedLock({ redisClient: otherRedis });
  });

  afterEach(async () => {
    await redis.del(key);
  });

  afterAll(() => {
    redis.disconnect();
    otherRedis.disconnect();
  });

  async function acquire(ttlMs = 10_000): Promise<string> {
    const token = await lock.acquire(key, ttlMs);
    expect(token).toEqual(expect.any(String));
    return token!;
  }

  async function waitForExpiry(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while ((await redis.exists(key)) !== 0 && Date.now() < deadline) {
      await delay(10);
    }
    expect(await redis.get(key)).toBeNull();
  }

  test('only one client acquires the key and Redis stores the owner with a TTL', async () => {
    const tokens = await Promise.all([lock.acquire(key, 10_000), otherLock.acquire(key, 10_000)]);
    const owners = tokens.filter((token) => token !== null);
    expect(owners).toHaveLength(1);
    expect(await redis.get(key)).toBe(owners[0]);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });

  test('only the owner extends the lease and changes its TTL', async () => {
    const token = await acquire();
    const originalTtl = await redis.pttl(key);

    expect(await otherLock.extend(key, randomUUID(), 60_000)).toBe(false);
    const rejectedTtl = await redis.pttl(key);
    expect(rejectedTtl).toBeGreaterThan(0);
    expect(rejectedTtl).toBeLessThanOrEqual(originalTtl);
    expect(await redis.get(key)).toBe(token);

    expect(await lock.extend(key, token, 60_000)).toBe(true);
    const extendedTtl = await redis.pttl(key);
    expect(extendedTtl).toBeGreaterThan(originalTtl);
    expect(extendedTtl).toBeLessThanOrEqual(60_000);
    expect(await redis.get(key)).toBe(token);
    expect(await otherLock.acquire(key, 10_000)).toBeNull();
  });

  test('only the owner releases the lease and another client can then acquire it', async () => {
    const token = await acquire();

    expect(await otherLock.release(key, randomUUID())).toBe(false);
    expect(await redis.get(key)).toBe(token);
    expect(await otherLock.acquire(key, 10_000)).toBeNull();

    expect(await lock.release(key, token)).toBe(true);
    expect(await redis.get(key)).toBeNull();
    expect(await lock.release(key, token)).toBe(false);
    const replacement = await otherLock.acquire(key, 10_000);
    expect(replacement).toEqual(expect.any(String));
    expect(replacement).not.toBe(token);
    expect(await redis.get(key)).toBe(replacement);
  });

  test.each(['extend', 'release'] as const)(
    '%s rejects an expired token without recreating the key',
    async (operation) => {
      const token = await acquire(50);
      await waitForExpiry();

      const result =
        operation === 'extend'
          ? await lock.extend(key, token, 60_000)
          : await lock.release(key, token);

      expect(result).toBe(false);
      expect(await redis.get(key)).toBeNull();
    },
  );

  test.each(['extend', 'release'] as const)(
    '%s rejects a stale token and preserves the replacement owner and TTL',
    async (operation) => {
      const token = await acquire(50);
      await waitForExpiry();
      const replacement = await otherLock.acquire(key, 10_000);
      expect(replacement).toEqual(expect.any(String));
      expect(replacement).not.toBe(token);
      const originalTtl = await redis.pttl(key);

      const result =
        operation === 'extend'
          ? await lock.extend(key, token, 60_000)
          : await lock.release(key, token);

      expect(result).toBe(false);
      expect(await redis.get(key)).toBe(replacement);
      const remainingTtl = await redis.pttl(key);
      expect(remainingTtl).toBeGreaterThan(0);
      expect(remainingTtl).toBeLessThanOrEqual(originalTtl);
      expect(await otherLock.extend(key, replacement!, 60_000)).toBe(true);
      expect(await otherLock.release(key, replacement!)).toBe(true);
    },
  );
});
