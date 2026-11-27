import { closeRedisClients } from '../redisClients.helper';

interface ViolationData {
  count?: number;
  timestamp?: number;
  namespace?: number;
  data?: string;
  userId?: string;
  violations?: Array<{
    type: string;
    timestamp: number;
    severity: string;
  }>;
  metadata?: {
    ip: string;
    userAgent: string;
    nested: {
      deep: {
        value: string;
      };
    };
  };
}

/** Waits for both Redis clients (ioredis + keyv/node-redis) to be ready */
async function waitForRedisClients() {
  const redisClients = await import('../../redisClients');
  const { ioredisClient, keyvRedisClientReady } = redisClients;

  if (ioredisClient && ioredisClient.status !== 'ready') {
    await new Promise<void>((resolve) => {
      ioredisClient.once('ready', resolve);
    });
  }

  if (keyvRedisClientReady) {
    await keyvRedisClientReady;
  }

  return redisClients;
}

describe('violationCache', () => {
  let originalEnv: NodeJS.ProcessEnv;

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

  test('should create violation cache with Redis when USE_REDIS is true', async () => {
    const cacheFactory = await import('../../cacheFactory');
    await waitForRedisClients();
    const cache = cacheFactory.violationCache('test-violations', 60000); // 60 second TTL

    // Verify it returns a Keyv instance
    expect(cache).toBeDefined();
    expect(cache.constructor.name).toBe('Keyv');

    // Test basic cache operations
    const testKey = 'user:456:violation';
    const testValue: ViolationData = { count: 1, timestamp: Date.now() };

    // SET operation
    await cache.set(testKey, testValue);

    // GET operation
    const retrievedValue = await cache.get(testKey);
    expect(retrievedValue).toEqual(testValue);

    // DELETE operation
    const deleted = await cache.delete(testKey);
    expect(deleted).toBe(true);

    // Verify deletion
    const afterDelete = await cache.get(testKey);
    expect(afterDelete).toBeUndefined();
  });

  test('should use fallback store when USE_REDIS is false', async () => {
    process.env.USE_REDIS = 'false';

    const cacheFactory = await import('../../cacheFactory');
    const cache = cacheFactory.violationCache('test-violations');

    // Verify it returns a Keyv instance
    expect(cache).toBeDefined();
    expect(cache.constructor.name).toBe('Keyv');

    // Test basic operations with fallback store
    const testKey = 'user:789:violation';
    const testValue: ViolationData = { count: 2, timestamp: Date.now() };

    // SET operation
    await cache.set(testKey, testValue);

    // GET operation
    const retrievedValue = await cache.get(testKey);
    expect(retrievedValue).toEqual(testValue);

    // DELETE operation
    const deleted = await cache.delete(testKey);
    expect(deleted).toBe(true);

    // Verify deletion
    const afterDelete = await cache.get(testKey);
    expect(afterDelete).toBeUndefined();
  });

  test('should respect namespace prefixing', async () => {
    const cacheFactory = await import('../../cacheFactory');
    await waitForRedisClients();
    const cache1 = cacheFactory.violationCache('namespace1');
    const cache2 = cacheFactory.violationCache('namespace2');

    const testKey = 'shared-key';
    const value1: ViolationData = { namespace: 1 };
    const value2: ViolationData = { namespace: 2 };

    // Set same key in different namespaces
    await cache1.set(testKey, value1);
    await cache2.set(testKey, value2);

    // Verify namespace isolation
    const retrieved1 = await cache1.get(testKey);
    const retrieved2 = await cache2.get(testKey);

    expect(retrieved1).toEqual(value1);
    expect(retrieved2).toEqual(value2);

    // Clean up
    await cache1.delete(testKey);
    await cache2.delete(testKey);
  });

  test('should respect TTL settings', async () => {
    const cacheFactory = await import('../../cacheFactory');
    await waitForRedisClients();
    const ttl = 1000; // 1 second TTL
    const cache = cacheFactory.violationCache('ttl-test', ttl);

    const testKey = 'ttl-key';
    const testValue: ViolationData = { data: 'expires soon' };

    // Set value with TTL
    await cache.set(testKey, testValue);

    // Verify value exists immediately
    const immediate = await cache.get(testKey);
    expect(immediate).toEqual(testValue);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, ttl + 100));

    // Verify value has expired
    const expired = await cache.get(testKey);
    expect(expired).toBeUndefined();
  });

  test('should handle complex violation data structures', async () => {
    const cacheFactory = await import('../../cacheFactory');
    await waitForRedisClients();
    const cache = cacheFactory.violationCache('complex-violations');

    const complexData: ViolationData = {
      userId: 'user123',
      violations: [
        { type: 'rate_limit', timestamp: Date.now(), severity: 'warning' },
        { type: 'spam', timestamp: Date.now() - 1000, severity: 'critical' },
      ],
      metadata: {
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        nested: {
          deep: {
            value: 'test',
          },
        },
      },
    };

    const key = 'complex-violation-data';

    // Store complex data
    await cache.set(key, complexData);

    // Retrieve and verify
    const retrieved = await cache.get(key);
    expect(retrieved).toEqual(complexData);

    // Clean up
    await cache.delete(key);
  });
});
