import type { RedisStore } from 'rate-limit-redis';
import { closeRedisClients } from '../redisClients.helper';

describe('limiterCache', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let testStore: RedisStore | undefined = undefined;

  beforeEach(() => {
    originalEnv = { ...process.env };

    // Set test configuration with fallback defaults for local testing
    process.env.REDIS_PING_INTERVAL = '0';
    process.env.REDIS_KEY_PREFIX = 'Cache-Integration-Test';
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '5';
    process.env.USE_REDIS = process.env.USE_REDIS || 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER || 'false';
    process.env.REDIS_URI = process.env.REDIS_URI || 'redis://127.0.0.1:6379';

    // Clear require cache to reload modules
    jest.resetModules();
  });

  afterEach(async () => {
    await closeRedisClients();
    process.env = originalEnv;
    jest.resetModules();
  });

  test('should throw error when prefix is not provided', async () => {
    const cacheFactory = await import('../../cacheFactory');
    expect(() => cacheFactory.limiterCache('')).toThrow('prefix is required');
  });

  test('should return undefined when USE_REDIS is false', async () => {
    process.env.USE_REDIS = 'false';

    const cacheFactory = await import('../../cacheFactory');
    testStore = cacheFactory.limiterCache('test-limiter');

    expect(testStore).toBeUndefined();
  });

  test('should return RedisStore with sendCommand when USE_REDIS is true', async () => {
    const cacheFactory = await import('../../cacheFactory');
    const redisClients = await import('../../redisClients');
    const { ioredisClient } = redisClients;
    testStore = cacheFactory.limiterCache('test-limiter');

    // Wait for Redis connection to be ready
    if (ioredisClient && ioredisClient.status !== 'ready') {
      await new Promise<void>((resolve) => {
        ioredisClient.once('ready', resolve);
      });
    }

    // Verify it returns a RedisStore instance
    expect(testStore).toBeDefined();
    expect(testStore!.constructor.name).toBe('RedisStore');
    expect(testStore!.prefix).toBe('Cache-Integration-Test::test-limiter:');
    expect(typeof testStore!.sendCommand).toBe('function');

    // rate-limit-redis sends uppercase dynamic commands. The pinned ioredis
    // key lookup is case-sensitive, so these raw calls bypass keyPrefix and
    // RedisStore must carry the deployment prefix itself.
    const limiterKey = 'rate-limit-user:123';
    testStore!.init({ windowMs: 60_000 } as Parameters<RedisStore['init']>[0]);
    await expect(testStore!.increment(limiterKey)).resolves.toMatchObject({ totalHits: 1 });
    expect(await ioredisClient!.call('GET', `${testStore!.prefix}${limiterKey}`)).toBe('1');
    expect(await ioredisClient!.call('GET', `test-limiter:${limiterKey}`)).toBeNull();
    expect(
      await ioredisClient!.call('GET', `Cache-Integration-Test::${testStore!.prefix}${limiterKey}`),
    ).toBeNull();
    await testStore!.resetKey(limiterKey);
    expect(await ioredisClient!.call('GET', `${testStore!.prefix}${limiterKey}`)).toBeNull();

    const testKey = 'user:123';

    // SET operation
    await testStore!.sendCommand('SET', testKey, '1', 'EX', '60');

    // Verify the key was created WITHOUT prefix using ioredis
    // Note: Using call method since get method seems to have issues in test environment
    // Type assertion for ioredis call method
    type RedisClientWithCall = typeof ioredisClient & {
      call: (command: string, key: string) => Promise<string | null>;
    };
    const directValue = await (ioredisClient as RedisClientWithCall).call('GET', testKey);

    expect(directValue).toBe('1');

    // GET operation
    const value = await testStore!.sendCommand('GET', testKey);
    expect(value).toBe('1');

    // INCR operation
    const incremented = await testStore!.sendCommand('INCR', testKey);
    expect(incremented).toBe(2);

    // Verify increment worked with ioredis
    const incrementedValue = await (ioredisClient as RedisClientWithCall).call('GET', testKey);
    expect(incrementedValue).toBe('2');

    // TTL operation
    const ttl = (await testStore!.sendCommand('TTL', testKey)) as number;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // DEL operation
    const deleted = await testStore!.sendCommand('DEL', testKey);
    expect(deleted).toBe(1);

    // Verify deletion
    const afterDelete = await testStore!.sendCommand('GET', testKey);
    expect(afterDelete).toBeNull();
    const directAfterDelete = await ioredisClient!.get(testKey);
    expect(directAfterDelete).toBeNull();

    // Test error handling
    await expect(testStore!.sendCommand('INVALID_COMMAND')).rejects.toThrow();
  });
});
