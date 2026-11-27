import type { MemoryStore, SessionData } from 'express-session';
import type { RedisStore as ConnectRedis } from 'connect-redis';
import { closeRedisClients } from '../redisClients.helper';

interface TestSessionData {
  [key: string]: unknown;
  cookie?: { maxAge: number };
  user?: { id: string; name: string };
  userId?: string;
}

type CacheSessionStore = MemoryStore | ConnectRedis;

describe('sessionCache', () => {
  let originalEnv: NodeJS.ProcessEnv;

  // Helper to make session stores async — uses generic store type to bridge
  // between MemoryStore/ConnectRedis and the test's relaxed SessionData shape.
  // The store methods accept express-session's SessionData but test data is
  // intentionally simpler; the cast bridges the gap for integration tests.
  const asyncStore = (store: CacheSessionStore) => ({
    set: (id: string, data: TestSessionData) =>
      new Promise<void>((resolve) =>
        store.set(id, data as Partial<SessionData> as SessionData, () => resolve()),
      ),
    get: (id: string) =>
      new Promise<TestSessionData | null | undefined>((resolve) =>
        store.get(id, (_, data) => resolve(data as TestSessionData | null | undefined)),
      ),
    destroy: (id: string) => new Promise<void>((resolve) => store.destroy(id, () => resolve())),
    touch: (id: string, data: TestSessionData) =>
      new Promise<void>((resolve) =>
        store.touch(id, data as Partial<SessionData> as SessionData, () => resolve()),
      ),
  });

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

  test('should return ConnectRedis store when USE_REDIS is true', async () => {
    const cacheFactory = await import('../../cacheFactory');
    const redisClients = await import('../../redisClients');
    const { ioredisClient } = redisClients;
    const store = cacheFactory.sessionCache('test-sessions', 3600);

    // Wait for Redis connection to be ready
    if (ioredisClient && ioredisClient.status !== 'ready') {
      await new Promise<void>((resolve) => {
        ioredisClient.once('ready', resolve);
      });
    }

    // Verify it returns a ConnectRedis instance
    expect(store).toBeDefined();
    expect(store.constructor.name).toBe('RedisStore');
    expect((store as CacheSessionStore & { prefix: string }).prefix).toBe('test-sessions:');

    // Test session operations
    const sessionId = 'sess:123456';
    const sessionData: TestSessionData = {
      user: { id: 'user123', name: 'Test User' },
      cookie: { maxAge: 3600000 },
    };

    const async = asyncStore(store);

    // Set session
    await async.set(sessionId, sessionData);

    // Get session
    const retrieved = await async.get(sessionId);
    expect(retrieved).toEqual(sessionData);

    // Touch session (update expiry)
    await async.touch(sessionId, sessionData);

    // Destroy session
    await async.destroy(sessionId);

    // Verify deletion
    const afterDelete = await async.get(sessionId);
    expect(afterDelete).toBeNull();
  });

  test('should return MemoryStore when USE_REDIS is false', async () => {
    process.env.USE_REDIS = 'false';

    const cacheFactory = await import('../../cacheFactory');
    const store = cacheFactory.sessionCache('test-sessions', 3600);

    // Verify it returns a MemoryStore instance
    expect(store).toBeDefined();
    expect(store.constructor.name).toBe('MemoryStore');

    // Test session operations
    const sessionId = 'mem:789012';
    const sessionData: TestSessionData = {
      user: { id: 'user456', name: 'Memory User' },
      cookie: { maxAge: 3600000 },
    };

    const async = asyncStore(store);

    // Set session
    await async.set(sessionId, sessionData);

    // Get session
    const retrieved = await async.get(sessionId);
    expect(retrieved).toEqual(sessionData);

    // Destroy session
    await async.destroy(sessionId);

    // Verify deletion
    const afterDelete = await async.get(sessionId);
    expect(afterDelete).toBeUndefined();
  });

  test('should handle namespace with and without trailing colon', async () => {
    const cacheFactory = await import('../../cacheFactory');

    const store1 = cacheFactory.sessionCache('namespace1');
    const store2 = cacheFactory.sessionCache('namespace2:');

    expect((store1 as CacheSessionStore & { prefix: string }).prefix).toBe('namespace1:');
    expect((store2 as CacheSessionStore & { prefix: string }).prefix).toBe('namespace2:');
  });

  test('should register error handler for Redis connection', async () => {
    const cacheFactory = await import('../../cacheFactory');
    const redisClients = await import('../../redisClients');
    const { ioredisClient } = redisClients;

    // Spy on ioredisClient.on
    const onSpy = jest.spyOn(ioredisClient!, 'on');

    // Create session store
    cacheFactory.sessionCache('error-test');

    // Verify error handler was registered
    expect(onSpy).toHaveBeenCalledWith('error', expect.any(Function));

    onSpy.mockRestore();
  });

  test('should handle session expiration with TTL', async () => {
    const cacheFactory = await import('../../cacheFactory');
    const redisClients = await import('../../redisClients');
    const { ioredisClient } = redisClients;
    const ttl = 1; // 1 second TTL
    const store = cacheFactory.sessionCache('ttl-sessions', ttl);

    // Wait for Redis connection to be ready
    if (ioredisClient && ioredisClient.status !== 'ready') {
      await new Promise<void>((resolve) => {
        ioredisClient.once('ready', resolve);
      });
    }

    const sessionId = 'ttl:12345';
    const sessionData: TestSessionData = { userId: 'ttl-user' };
    const async = asyncStore(store);

    // Set session with short TTL
    await async.set(sessionId, sessionData);

    // Verify session exists immediately
    const immediate = await async.get(sessionId);
    expect(immediate).toEqual(sessionData);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, (ttl + 0.5) * 1000));

    // Verify session has expired
    const expired = await async.get(sessionId);
    expect(expired).toBeNull();
  });
});
