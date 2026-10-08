import type { Redis, Cluster } from 'ioredis';
import { closeRedisClients } from '../../cache/__tests__/redisClients.helper';

/**
 * Integration tests for concurrency middleware atomic Lua scripts.
 *
 * Tests that the Lua-based check-and-increment / decrement operations
 * are truly atomic and eliminate the INCR+check+DECR race window.
 *
 * Run with: USE_REDIS=true npx jest --config packages/api/jest.config.js concurrency.cache_integration
 */
describe('Concurrency Middleware Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  let checkAndIncrementPendingRequest: (
    userId: string,
  ) => Promise<{ allowed: boolean; pendingRequests: number; limit: number }>;
  let decrementPendingRequest: (userId: string) => Promise<void>;
  const testPrefix = 'Concurrency-Integration-Test';

  beforeAll(async () => {
    originalEnv = { ...process.env };

    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER ?? 'false';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    process.env.REDIS_PING_INTERVAL = '0';
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '5';
    process.env.LIMIT_CONCURRENT_MESSAGES = 'true';
    process.env.CONCURRENT_MESSAGE_MAX = '2';

    jest.resetModules();

    const { ioredisClient: client } = await import('../../cache/redisClients');
    ioredisClient = client;

    if (!ioredisClient) {
      console.warn('Redis not available, skipping integration tests');
      return;
    }

    // Import concurrency module after Redis client is available
    const concurrency = await import('../concurrency');
    checkAndIncrementPendingRequest = concurrency.checkAndIncrementPendingRequest;
    decrementPendingRequest = concurrency.decrementPendingRequest;
  });

  afterEach(async () => {
    if (!ioredisClient) {
      return;
    }

    try {
      const keys = await ioredisClient.keys(`${testPrefix}*`);
      if (keys.length > 0) {
        await Promise.all(keys.map((key) => ioredisClient!.del(key)));
      }
    } catch (error) {
      console.warn('Error cleaning up test keys:', error);
    }
  });

  afterAll(async () => {
    await closeRedisClients();
    process.env = originalEnv;
  });

  describe('Atomic Check and Increment', () => {
    test('should allow requests within the concurrency limit', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-allow-${Date.now()}`;

      // First request - should be allowed (count = 1, limit = 2)
      const result1 = await checkAndIncrementPendingRequest(userId);
      expect(result1.allowed).toBe(true);
      expect(result1.pendingRequests).toBe(1);
      expect(result1.limit).toBe(2);

      // Second request - should be allowed (count = 2, limit = 2)
      const result2 = await checkAndIncrementPendingRequest(userId);
      expect(result2.allowed).toBe(true);
      expect(result2.pendingRequests).toBe(2);
    });

    test('should reject requests over the concurrency limit', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-reject-${Date.now()}`;

      // Fill up to the limit
      await checkAndIncrementPendingRequest(userId);
      await checkAndIncrementPendingRequest(userId);

      // Third request - should be rejected (count would be 3, limit = 2)
      const result = await checkAndIncrementPendingRequest(userId);
      expect(result.allowed).toBe(false);
      expect(result.pendingRequests).toBe(3); // Reports the count that was over-limit
    });

    test('should not leave stale counter after rejection (atomic rollback)', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-rollback-${Date.now()}`;

      // Fill up to the limit
      await checkAndIncrementPendingRequest(userId);
      await checkAndIncrementPendingRequest(userId);

      // Attempt over-limit (should be rejected and atomically rolled back)
      const rejected = await checkAndIncrementPendingRequest(userId);
      expect(rejected.allowed).toBe(false);

      // The key value should still be 2, not 3 — verify the Lua script decremented back
      const key = `PENDING_REQ:${userId}`;
      const rawValue = await ioredisClient.get(key);
      expect(rawValue).toBe('2');
    });

    test('should handle concurrent requests atomically (no over-admission)', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-concurrent-${Date.now()}`;

      // Fire 20 concurrent requests for the same user (limit = 2)
      const results = await Promise.all(
        Array.from({ length: 20 }, () => checkAndIncrementPendingRequest(userId)),
      );

      const allowed = results.filter((r) => r.allowed);
      const rejected = results.filter((r) => !r.allowed);

      // Exactly 2 should be allowed (the concurrency limit)
      expect(allowed.length).toBe(2);
      expect(rejected.length).toBe(18);

      // The key value should be exactly 2 after all atomic operations
      const key = `PENDING_REQ:${userId}`;
      const rawValue = await ioredisClient.get(key);
      expect(rawValue).toBe('2');

      // Clean up
      await decrementPendingRequest(userId);
      await decrementPendingRequest(userId);
    });
  });

  describe('Atomic Decrement', () => {
    test('should decrement pending requests', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-decrement-${Date.now()}`;

      await checkAndIncrementPendingRequest(userId);
      await checkAndIncrementPendingRequest(userId);

      // Decrement once
      await decrementPendingRequest(userId);

      const key = `PENDING_REQ:${userId}`;
      const rawValue = await ioredisClient.get(key);
      expect(rawValue).toBe('1');
    });

    test('should clean up key when count reaches zero', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-cleanup-${Date.now()}`;

      await checkAndIncrementPendingRequest(userId);
      await decrementPendingRequest(userId);

      // Key should be deleted (not left as "0")
      const key = `PENDING_REQ:${userId}`;
      const exists = await ioredisClient.exists(key);
      expect(exists).toBe(0);
    });

    test('should clean up key on double-decrement (negative protection)', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-double-decr-${Date.now()}`;

      await checkAndIncrementPendingRequest(userId);
      await decrementPendingRequest(userId);
      await decrementPendingRequest(userId); // Double-decrement

      // Key should be deleted, not negative
      const key = `PENDING_REQ:${userId}`;
      const exists = await ioredisClient.exists(key);
      expect(exists).toBe(0);
    });

    test('should allow new requests after decrement frees a slot', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-free-slot-${Date.now()}`;

      // Fill to limit
      await checkAndIncrementPendingRequest(userId);
      await checkAndIncrementPendingRequest(userId);

      // Verify at limit
      const atLimit = await checkAndIncrementPendingRequest(userId);
      expect(atLimit.allowed).toBe(false);

      // Free a slot
      await decrementPendingRequest(userId);

      // Should now be allowed again
      const allowed = await checkAndIncrementPendingRequest(userId);
      expect(allowed.allowed).toBe(true);
      expect(allowed.pendingRequests).toBe(2);
    });
  });

  describe('TTL Behavior', () => {
    test('should set TTL on the concurrency key', async () => {
      if (!ioredisClient) {
        return;
      }

      const userId = `user-ttl-${Date.now()}`;
      await checkAndIncrementPendingRequest(userId);

      const key = `PENDING_REQ:${userId}`;
      const ttl = await ioredisClient.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });
  });
});
