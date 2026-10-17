/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "testRedisOperations"] }] */
import type { RedisClientType, RedisClusterType } from '@redis/client';
import type { Redis, Cluster } from 'ioredis';
import { closeRedisClients } from './redisClients.helper';

type RedisClient = RedisClientType | RedisClusterType | Redis | Cluster;

describe('redisClients Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  let keyvRedisClient: RedisClientType | RedisClusterType | null = null;

  // Helper function to test set/get/delete operations
  const testRedisOperations = async (
    client: RedisClient,
    keyPrefix: string,
    readyPromise?: Promise<void>,
  ): Promise<void> => {
    // Wait for connection and topology discovery to complete
    if (readyPromise) await readyPromise;

    const testKey = `${keyPrefix}-test-key`;
    const testValue = `${keyPrefix}-test-value`;

    // Test set operation
    await client.set(testKey, testValue);

    // Test get operation
    const result = await client.get(testKey);
    expect(result).toBe(testValue);

    // Test delete operation
    const deleteResult = await client.del([testKey]);
    expect(deleteResult).toBe(1);

    // Verify key is deleted
    const deletedResult = await client.get(testKey);
    expect(deletedResult).toBeNull();
  };

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Set common test configuration with fallback defaults for local testing
    process.env.REDIS_PING_INTERVAL = '1000';
    process.env.REDIS_KEY_PREFIX = 'Redis-Integration-Test';
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '5';
    process.env.USE_REDIS = process.env.USE_REDIS || 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER || 'false';
    process.env.REDIS_URI = process.env.REDIS_URI || 'redis://127.0.0.1:6379';

    // Clear module cache to reload module
    jest.resetModules();
  });

  afterEach(async () => {
    // Clean up test keys using the prefix
    if (ioredisClient && ioredisClient.status === 'ready') {
      try {
        const keys = await ioredisClient.keys('Redis-Integration-Test::*');
        if (keys.length > 0) {
          await ioredisClient.del(...keys);
        }
      } catch (error) {
        console.warn('Error cleaning up test keys:', (error as Error).message);
      }
    }

    // Close BOTH clients created by the module import, not just the one the test exercised
    await closeRedisClients();
    ioredisClient = null;
    keyvRedisClient = null;

    process.env = originalEnv;
    jest.resetModules();
  });

  describe('ioredis Client Tests', () => {
    describe('when USE_REDIS is false', () => {
      test('should have null client', async () => {
        process.env.USE_REDIS = 'false';

        const clients = await import('../redisClients');
        ioredisClient = clients.ioredisClient;

        expect(ioredisClient).toBeNull();
      });
    });

    describe('when connecting to a Redis instance', () => {
      test('should connect and perform set/get/delete operations', async () => {
        const clients = await import('../redisClients');
        ioredisClient = clients.ioredisClient;
        await testRedisOperations(ioredisClient!, 'ioredis-single');
      });
    });

    describe('when connecting to a Redis cluster', () => {
      test('should connect to cluster and perform set/get/delete operations', async () => {
        process.env.USE_REDIS_CLUSTER = 'true';
        process.env.REDIS_URI =
          'redis://127.0.0.1:7001,redis://127.0.0.1:7002,redis://127.0.0.1:7003';

        const clients = await import('../redisClients');
        ioredisClient = clients.ioredisClient;
        await testRedisOperations(ioredisClient!, 'ioredis-cluster');
      });
    });

    describe('address family', () => {
      test('should accept either address family on a single instance', async () => {
        process.env.USE_REDIS_CLUSTER = 'false';
        process.env.REDIS_URI = 'redis://127.0.0.1:6379';

        const clients = await import('../redisClients');
        ioredisClient = clients.ioredisClient;

        expect(ioredisClient!.options).toMatchObject({ family: 0 });
      });

      test('should accept either address family on cluster nodes', async () => {
        process.env.USE_REDIS_CLUSTER = 'true';
        process.env.REDIS_URI =
          'redis://127.0.0.1:7001,redis://127.0.0.1:7002,redis://127.0.0.1:7003';

        const clients = await import('../redisClients');
        ioredisClient = clients.ioredisClient;

        expect(ioredisClient!.options).toMatchObject({ redisOptions: { family: 0 } });
      });
    });
  });

  describe('keyvRedisClient Tests', () => {
    describe('when USE_REDIS is false', () => {
      test('should have null client', async () => {
        process.env.USE_REDIS = 'false';

        const clients = await import('../redisClients');
        keyvRedisClient = clients.keyvRedisClient;
        expect(keyvRedisClient).toBeNull();
      });
    });

    describe('when connecting to a Redis instance', () => {
      test('should connect and perform set/get/delete operations', async () => {
        const clients = await import('../redisClients');
        keyvRedisClient = clients.keyvRedisClient;
        await testRedisOperations(
          keyvRedisClient!,
          'keyv-single',
          clients.keyvRedisClientReady!.then(() => undefined),
        );
      });
    });

    describe('when connecting to a Redis cluster', () => {
      test('should connect to cluster and perform set/get/delete operations', async () => {
        process.env.USE_REDIS_CLUSTER = 'true';
        process.env.REDIS_URI =
          'redis://127.0.0.1:7001,redis://127.0.0.1:7002,redis://127.0.0.1:7003';

        const clients = await import('../redisClients');
        keyvRedisClient = clients.keyvRedisClient;
        await testRedisOperations(
          keyvRedisClient!,
          'keyv-cluster',
          clients.keyvRedisClientReady!.then(() => undefined),
        );
      });

      test('should execute same-slot catalog scripts on the owning master', async () => {
        process.env.USE_REDIS_CLUSTER = 'true';
        process.env.REDIS_URI =
          'redis://127.0.0.1:7001,redis://127.0.0.1:7002,redis://127.0.0.1:7003';

        const clients = await import('../redisClients');
        keyvRedisClient = clients.keyvRedisClient;
        const hashTag = `catalog-eval-${Date.now()}`;
        const keys = [`catalog:revision:{${hashTag}}`, `catalog:tools:{${hashTag}}`];

        await expect(
          clients.evalKeyvRedisScript(
            "redis.call('SET', KEYS[1], ARGV[1]); redis.call('SET', KEYS[2], ARGV[1]); return 1",
            { keys, arguments: ['published'] },
          ),
        ).resolves.toBe(1);
        await expect(keyvRedisClient!.mGet(keys)).resolves.toEqual(['published', 'published']);
        await keyvRedisClient!.del(keys);
      });
    });
  });
});
