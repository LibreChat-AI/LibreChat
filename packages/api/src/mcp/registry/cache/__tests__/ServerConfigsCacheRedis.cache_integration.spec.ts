import { expect } from '@playwright/test';
import type { RedisClientsModule } from '~/cache/__tests__/redisClients.helper';
import { closeRedisClients } from '~/cache/__tests__/redisClients.helper';
import { ParsedServerConfig } from '~/mcp/types';

type StdioServerConfig = Extract<ParsedServerConfig, { type: 'stdio' }>;

describe('ServerConfigsCacheRedis Integration Tests', () => {
  let ServerConfigsCacheRedis: typeof import('../ServerConfigsCacheRedis').ServerConfigsCacheRedis;
  let keyvRedisClient: Awaited<typeof import('~/cache/redisClients')>['keyvRedisClient'];
  let redisClientsModule: RedisClientsModule;

  let cache: InstanceType<typeof import('../ServerConfigsCacheRedis').ServerConfigsCacheRedis>;

  const mockConfig1: StdioServerConfig = {
    type: 'stdio',
    command: 'node',
    args: ['server1.js'],
    env: { TEST: 'value1' },
  };

  const mockConfig2: StdioServerConfig = {
    type: 'stdio',
    command: 'python',
    args: ['server2.py'],
    env: { TEST: 'value2' },
  };

  const mockConfig3 = {
    type: 'sse',
    url: 'http://localhost:3000',
    requiresOAuth: true,
  } as ParsedServerConfig;

  beforeAll(async () => {
    // Set up environment variables for Redis (only if not already set)
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER ?? 'true';
    process.env.REDIS_URI =
      process.env.REDIS_URI ??
      'redis://127.0.0.1:7001,redis://127.0.0.1:7002,redis://127.0.0.1:7003';
    process.env.REDIS_KEY_PREFIX =
      process.env.REDIS_KEY_PREFIX ?? 'ServerConfigsCacheRedis-IntegrationTest';

    // Import modules after setting env vars
    const cacheModule = await import('../ServerConfigsCacheRedis');
    const redisClients = await import('~/cache/redisClients');

    ServerConfigsCacheRedis = cacheModule.ServerConfigsCacheRedis;
    keyvRedisClient = redisClients.keyvRedisClient;
    redisClientsModule = redisClients;

    // Ensure Redis is connected
    if (!keyvRedisClient) throw new Error('Redis client is not initialized');

    // Wait for connection and topology discovery to complete
    await redisClients.keyvRedisClientReady;
  });

  beforeEach(() => {
    jest.resetModules();
    cache = new ServerConfigsCacheRedis('test-user', false);
  });

  afterEach(async () => {
    // Clean up: clear all test keys from Redis
    if (keyvRedisClient && 'scanIterator' in keyvRedisClient) {
      const pattern = '*ServerConfigsCacheRedis-IntegrationTest*';
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
    // Close both Redis clients; pass the captured module since
    // `jest.resetModules()` in beforeEach dropped it from the registry
    await closeRedisClients(redisClientsModule);
  });

  describe('add and get operations', () => {
    it('should add and retrieve a server config', async () => {
      await cache.add('server1', mockConfig1);
      const result = await cache.get('server1');
      expect(result).toMatchObject(mockConfig1);
    });

    it('should return undefined for non-existent server', async () => {
      const result = await cache.get('non-existent');
      expect(result).toBeUndefined();
    });

    it('should throw error when adding duplicate server', async () => {
      await cache.add('server1', mockConfig1);
      await expect(cache.add('server1', mockConfig2)).rejects.toThrow(
        'Server "server1" already exists in cache. Use update() to modify existing configs.',
      );
    });

    it('should handle multiple server configs', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);
      await cache.add('server3', mockConfig3);

      const result1 = await cache.get('server1');
      const result2 = await cache.get('server2');
      const result3 = await cache.get('server3');

      expect(result1).toMatchObject(mockConfig1);
      expect(result2).toMatchObject(mockConfig2);
      expect(result3).toMatchObject(mockConfig3);
    });

    it('should isolate caches by owner namespace', async () => {
      const userCache = new ServerConfigsCacheRedis('user1-private', false);
      const globalCache = new ServerConfigsCacheRedis('global-shared', false);

      await userCache.add('server1', mockConfig1);
      await globalCache.add('server1', mockConfig2);

      const userResult = await userCache.get('server1');
      const globalResult = await globalCache.get('server1');

      expect(userResult).toMatchObject(mockConfig1);
      expect(globalResult).toMatchObject(mockConfig2);
    });
  });

  describe('patch operation', () => {
    it('preserves empty arrays in a patched per-key entry', async () => {
      const emptyArgsConfig: StdioServerConfig = { ...mockConfig1, args: [] };
      const { config } = await cache.add('empty-arrays', emptyArgsConfig);

      await expect(
        cache.patch('empty-arrays', { resolvedInstructions: 'patched' }, config.updatedAt),
      ).resolves.toBe(true);

      const result = await cache.get('empty-arrays');
      expect(result).toMatchObject({ args: [] });
      expect(result?.resolvedInstructions).toBe('patched');
    });
  });

  describe('getAll operation', () => {
    it('should return empty object when no servers exist', async () => {
      const result = await cache.getAll();
      expect(result).toMatchObject({});
    });

    it('should return all server configs', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);
      await cache.add('server3', mockConfig3);

      const result = await cache.getAll();
      expect(result).toMatchObject({
        server1: mockConfig1,
        server2: mockConfig2,
        server3: mockConfig3,
      });
    });

    it('should reflect updates in getAll', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);

      let result = await cache.getAll();
      expect(Object.keys(result).length).toBe(2);

      await cache.add('server3', mockConfig3);
      result = await cache.getAll();
      expect(Object.keys(result).length).toBe(3);
      expect(result.server3).toMatchObject(mockConfig3);
    });

    it('should only return configs for the specific owner', async () => {
      const userCache = new ServerConfigsCacheRedis('user1-owner', false);
      const globalCache = new ServerConfigsCacheRedis('global-owner', false);

      await userCache.add('server1', mockConfig1);
      await userCache.add('server2', mockConfig2);
      await globalCache.add('server3', mockConfig3);

      const userResult = await userCache.getAll();
      const globalResult = await globalCache.getAll();

      expect(Object.keys(userResult).length).toBe(2);
      expect(Object.keys(globalResult).length).toBe(1);
      expect(userResult.server1).toMatchObject(mockConfig1);
      expect(userResult.server3).toBeUndefined();
      expect(globalResult.server3).toMatchObject(mockConfig3);
    });
  });

  describe('update operation', () => {
    it('should update an existing server config', async () => {
      await cache.add('server1', mockConfig1);
      expect(await cache.get('server1')).toMatchObject(mockConfig1);

      await cache.update('server1', mockConfig2);
      const result = await cache.get('server1');
      expect(result).toMatchObject(mockConfig2);
    });

    it('should throw error when updating non-existent server', async () => {
      await expect(cache.update('non-existent', mockConfig1)).rejects.toThrow(
        'Server "non-existent" does not exist in cache. Use add() to create new configs.',
      );
    });

    it('should reflect updates in getAll', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);

      await cache.update('server1', mockConfig3);
      const result = await cache.getAll();
      expect(result.server1).toMatchObject(mockConfig3);
      expect(result.server2).toMatchObject(mockConfig2);
    });

    it('should only update in the specific owner namespace', async () => {
      const userCache = new ServerConfigsCacheRedis('user1-update', false);
      const globalCache = new ServerConfigsCacheRedis('global-update', false);

      await userCache.add('server1', mockConfig1);
      await globalCache.add('server1', mockConfig2);

      await userCache.update('server1', mockConfig3);

      expect(await userCache.get('server1')).toMatchObject(mockConfig3);
      expect(await globalCache.get('server1')).toMatchObject(mockConfig2);
    });
  });

  describe('remove operation', () => {
    it('should remove an existing server config', async () => {
      await cache.add('server1', mockConfig1);
      expect(await cache.get('server1')).toMatchObject(mockConfig1);

      await cache.remove('server1');
      expect(await cache.get('server1')).toBeUndefined();
    });

    it('should throw error when removing non-existent server', async () => {
      await expect(cache.remove('non-existent')).rejects.toThrow(
        'Failed to remove test-user server "non-existent"',
      );
    });

    it('should remove server from getAll results', async () => {
      await cache.add('server1', mockConfig1);
      await cache.add('server2', mockConfig2);

      let result = await cache.getAll();
      expect(Object.keys(result).length).toBe(2);

      await cache.remove('server1');
      result = await cache.getAll();
      expect(Object.keys(result).length).toBe(1);
      expect(result.server1).toBeUndefined();
      expect(result.server2).toMatchObject(mockConfig2);
    });

    it('should allow re-adding a removed server', async () => {
      await cache.add('server1', mockConfig1);
      await cache.remove('server1');
      await cache.add('server1', mockConfig3);

      const result = await cache.get('server1');
      expect(result).toMatchObject(mockConfig3);
    });

    it('should only remove from the specific owner namespace', async () => {
      const userCache = new ServerConfigsCacheRedis('user1-remove', false);
      const globalCache = new ServerConfigsCacheRedis('global-remove', false);

      await userCache.add('server1', mockConfig1);
      await globalCache.add('server1', mockConfig2);

      await userCache.remove('server1');

      expect(await userCache.get('server1')).toBeUndefined();
      expect(await globalCache.get('server1')).toMatchObject(mockConfig2);
    });
  });

  describe('getAll parallel fetching', () => {
    it('should handle many configs efficiently with parallel fetching', async () => {
      const testCache = new ServerConfigsCacheRedis('parallel-test', false);
      const configCount = 20;

      for (let i = 0; i < configCount; i++) {
        await testCache.add(`server-${i}`, {
          type: 'stdio',
          command: `cmd-${i}`,
          args: [`arg-${i}`],
        } as ParsedServerConfig);
      }

      const startTime = Date.now();
      const result = await testCache.getAll();
      const elapsed = Date.now() - startTime;

      expect(Object.keys(result).length).toBe(configCount);
      for (let i = 0; i < configCount; i++) {
        expect(result[`server-${i}`]).toBeDefined();
        const config = result[`server-${i}`] as { command?: string };
        expect(config.command).toBe(`cmd-${i}`);
      }

      expect(elapsed).toBeLessThan(5000);
    });

    it('should handle concurrent getAll calls without timeout', async () => {
      const testCache = new ServerConfigsCacheRedis('concurrent-test', false);

      for (let i = 0; i < 10; i++) {
        await testCache.add(`server-${i}`, {
          type: 'stdio',
          command: `cmd-${i}`,
          args: [`arg-${i}`],
        } as ParsedServerConfig);
      }

      const concurrentCalls = 50;
      const startTime = Date.now();
      const promises = Array.from({ length: concurrentCalls }, () => testCache.getAll());

      const results = await Promise.all(promises);
      const elapsed = Date.now() - startTime;

      for (const result of results) {
        expect(Object.keys(result).length).toBe(10);
      }

      expect(elapsed).toBeLessThan(10000);
    });

    it('should return consistent results across concurrent calls', async () => {
      const testCache = new ServerConfigsCacheRedis('consistency-test', false);

      await testCache.add('server-a', mockConfig1);
      await testCache.add('server-b', mockConfig2);
      await testCache.add('server-c', mockConfig3);

      const results = await Promise.all([
        testCache.getAll(),
        testCache.getAll(),
        testCache.getAll(),
        testCache.getAll(),
        testCache.getAll(),
      ]);

      const firstResult = results[0];
      for (const result of results) {
        expect(Object.keys(result).sort()).toEqual(Object.keys(firstResult).sort());
        expect(result['server-a']).toMatchObject(mockConfig1);
        expect(result['server-b']).toMatchObject(mockConfig2);
        expect(result['server-c']).toMatchObject(mockConfig3);
      }
    });

    /**
     * Performance regression test for N+1 Redis fix.
     *
     * Before fix: getAll() used sequential GET calls inside an async loop:
     *   for await (key of scan) { await cache.get(key); }  // N sequential calls
     *
     * With 30 configs and 100 concurrent requests, this would cause:
     *   - 100 × 30 = 3000 sequential Redis roundtrips
     *   - Under load, requests would queue and timeout at 60s
     *
     * After fix: getAll() uses Promise.all for parallel fetching:
     *   Promise.all(keys.map(k => cache.get(k)));  // N parallel calls
     *
     * This test validates the fix by ensuring 100 concurrent requests
     * complete in under 5 seconds - impossible with the old N+1 pattern.
     */
    it('should complete 100 concurrent requests in under 5s (regression test for N+1 fix)', async () => {
      const testCache = new ServerConfigsCacheRedis('perf-regression-test', false);
      const configCount = 30;

      for (let i = 0; i < configCount; i++) {
        await testCache.add(`server-${i}`, {
          type: 'stdio',
          command: `cmd-${i}`,
          args: [`arg-${i}`],
        } as ParsedServerConfig);
      }

      const concurrentRequests = 100;
      const maxAllowedMs = 5000;

      const startTime = Date.now();
      const promises = Array.from({ length: concurrentRequests }, () => testCache.getAll());
      const results = await Promise.all(promises);
      const elapsed = Date.now() - startTime;

      expect(results.length).toBe(concurrentRequests);
      for (const result of results) {
        expect(Object.keys(result).length).toBe(configCount);
      }

      expect(elapsed).toBeLessThan(maxAllowedMs);
    });
  });
});
