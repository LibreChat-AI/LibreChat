import { batchDeleteKeys, scanKeys } from '../redisUtils';
import { closeRedisClients } from './redisClients.helper';

describe('redisUtils Integration Tests', () => {
  let keyvRedisClient: Awaited<typeof import('../redisClients')>['keyvRedisClient'];
  const testPrefix = 'RedisUtils-Integration-Test';

  beforeAll(async () => {
    // Set up environment variables for Redis (only if not already set)
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? testPrefix;
    process.env.REDIS_DELETE_CHUNK_SIZE = '100';

    // Clear module cache to ensure fresh initialization with new env vars
    jest.resetModules();

    // Import modules after setting env vars and clearing cache
    const redisClients = await import('../redisClients');
    keyvRedisClient = redisClients.keyvRedisClient;

    // Ensure Redis is connected
    if (!keyvRedisClient) throw new Error('Redis client is not initialized');

    // Wait for connection and topology discovery to complete
    await redisClients.keyvRedisClientReady;
  });

  afterEach(async () => {
    // Clean up: clear all test keys from Redis
    if (keyvRedisClient && 'scanIterator' in keyvRedisClient) {
      const pattern = `*${testPrefix}*`;
      const keysToDelete: string[] = [];

      // Collect all keys first
      for await (const page of keyvRedisClient.scanIterator({ MATCH: pattern })) {
        keysToDelete.push(...page);
      }

      // Delete in parallel for cluster mode efficiency
      if (keysToDelete.length > 0) {
        await Promise.all(keysToDelete.map((key) => keyvRedisClient!.del(key)));
      }
    }
  });

  afterAll(async () => {
    // Close both Redis clients created by the module import
    await closeRedisClients();
  });

  describe('batchDeleteKeys', () => {
    test('should delete multiple keys successfully', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      // Setup: Create test keys
      const keys = [
        `${testPrefix}::key1`,
        `${testPrefix}::key2`,
        `${testPrefix}::key3`,
        `${testPrefix}::key4`,
        `${testPrefix}::key5`,
      ];

      for (const key of keys) {
        await keyvRedisClient.set(key, 'test-value');
      }

      // Verify keys exist
      for (const key of keys) {
        const exists = await keyvRedisClient.exists(key);
        expect(exists).toBe(1);
      }

      // Execute: Delete keys
      const deletedCount = await batchDeleteKeys(keyvRedisClient, keys);

      // Verify: All keys deleted
      expect(deletedCount).toBe(5);

      for (const key of keys) {
        const exists = await keyvRedisClient.exists(key);
        expect(exists).toBe(0);
      }
    });

    test('should handle large batch deletions (>1000 keys)', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      // Create 1500 test keys
      const keys: string[] = [];
      for (let i = 0; i < 1500; i++) {
        keys.push(`${testPrefix}::large-batch::${i}`);
      }

      // Set all keys in batches to avoid overwhelming cluster
      const setBatchSize = 100;
      for (let i = 0; i < keys.length; i += setBatchSize) {
        const batch = keys.slice(i, i + setBatchSize);
        await Promise.all(batch.map((key) => keyvRedisClient!.set(key, 'value')));
      }

      // Delete in batches
      const deletedCount = await batchDeleteKeys(keyvRedisClient, keys, 500);

      // Verify all deleted
      expect(deletedCount).toBe(1500);

      const existsResults = await Promise.all(keys.map((key) => keyvRedisClient!.exists(key)));
      const totalExists = existsResults.reduce((sum, exists) => sum + exists, 0);
      expect(totalExists).toBe(0);
    });

    test('should handle mixed existing and non-existing keys', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      const existingKeys = [`${testPrefix}::exists1`, `${testPrefix}::exists2`];
      const nonExistingKeys = [`${testPrefix}::noexist1`, `${testPrefix}::noexist2`];

      // Create only some keys
      for (const key of existingKeys) {
        await keyvRedisClient.set(key, 'value');
      }

      // Try to delete both existing and non-existing
      const allKeys = [...existingKeys, ...nonExistingKeys];
      const deletedCount = await batchDeleteKeys(keyvRedisClient, allKeys);

      // Should only delete the existing ones
      expect(deletedCount).toBe(2);
    });

    test('should work with custom chunk sizes', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      const keys = Array.from({ length: 75 }, (_, i) => `${testPrefix}::chunk::${i}`);

      // Set all keys
      await Promise.all(keys.map((key) => keyvRedisClient!.set(key, 'value')));

      // Delete with small chunk size (25)
      const deletedCount = await batchDeleteKeys(keyvRedisClient, keys, 25);

      expect(deletedCount).toBe(75);
    });

    test('should return 0 for empty keys array', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      const deletedCount = await batchDeleteKeys(keyvRedisClient, []);
      expect(deletedCount).toBe(0);
    });
  });

  describe('scanKeys', () => {
    test('should scan and find all matching keys', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      // Create test keys with a specific pattern
      const userKeys = [
        `${testPrefix}::user::1`,
        `${testPrefix}::user::2`,
        `${testPrefix}::user::3`,
      ];
      const sessionKeys = [`${testPrefix}::session::1`, `${testPrefix}::session::2`];

      // Set all keys
      await Promise.all(
        [...userKeys, ...sessionKeys].map((key) => keyvRedisClient!.set(key, 'value')),
      );

      // Scan for user keys only
      const foundKeys = await scanKeys(keyvRedisClient, `${testPrefix}::user::*`);

      // Should find only user keys
      expect(foundKeys).toHaveLength(3);
      expect(foundKeys.sort()).toEqual(userKeys.sort());
    });

    test('should scan large number of keys', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      // Create 2000 test keys
      const keys: string[] = [];
      for (let i = 0; i < 2000; i++) {
        keys.push(`${testPrefix}::large-scan::${i}`);
      }

      // Set all keys in batches to avoid overwhelming cluster
      const setBatchSize = 100;
      for (let i = 0; i < keys.length; i += setBatchSize) {
        const batch = keys.slice(i, i + setBatchSize);
        await Promise.all(batch.map((key) => keyvRedisClient!.set(key, 'value')));
      }

      // Scan with custom count
      const foundKeys = await scanKeys(keyvRedisClient, `${testPrefix}::large-scan::*`, 500);

      // Should find all keys
      expect(foundKeys).toHaveLength(2000);
      expect(foundKeys.sort()).toEqual(keys.sort());
    });

    test('should return empty array when no keys match pattern', async () => {
      if (!keyvRedisClient) throw new Error('Redis client not available');

      const foundKeys = await scanKeys(keyvRedisClient, `${testPrefix}::nonexistent::*`);

      expect(foundKeys).toEqual([]);
    });
  });
});
