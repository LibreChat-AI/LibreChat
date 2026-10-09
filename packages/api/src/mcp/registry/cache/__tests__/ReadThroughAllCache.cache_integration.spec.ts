import { randomUUID } from 'crypto';
import { closeRedisClients } from '~/cache/__tests__/redisClients.helper';

/**
 * Redis-backed integration tests for the registry read-through cache (#14016).
 * Two instances over one namespace model two containers: they share entries
 * through Redis, and a generation invalidation on one orphans the entries for
 * the other without any keyspace scan.
 */
describe('ReadThroughAllCache (Redis backing)', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const testPrefix = 'RTAC-Integration-Test';

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.REDIS_PING_INTERVAL = '0';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '5';
    process.env.USE_REDIS = 'true';
    process.env.USE_REDIS_CLUSTER = 'false';
    process.env.REDIS_URI = 'redis://127.0.0.1:6379';
    jest.resetModules();
  });

  afterEach(async () => {
    const redisClients = await import('~/cache/redisClients');
    const { ioredisClient } = redisClients;
    if (ioredisClient && ioredisClient.status === 'ready') {
      try {
        const keys = await ioredisClient.keys(`${testPrefix}*`);
        if (keys.length > 0) {
          await ioredisClient.del(...keys);
        }
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.warn('Error cleaning up test keys:', error.message);
        }
      }
    }
    await closeRedisClients(redisClients);
    process.env = originalEnv;
  });

  test('entries are shared across instances through Redis', async () => {
    const { ReadThroughAllCache } = await import('../ReadThroughAllCache');
    const namespace = `rtac-redis-${randomUUID()}`;
    const writer = new ReadThroughAllCache<string>(namespace, 60_000);
    const reader = new ReadThroughAllCache<string>(namespace, 60_000);

    await writer.set('user-1', 'written-by-other-instance');

    await expect(reader.get('user-1')).resolves.toEqual({
      hit: true,
      value: 'written-by-other-instance',
    });
  });

  test('invalidateAll on one instance orphans entries for the other', async () => {
    const { ReadThroughAllCache } = await import('../ReadThroughAllCache');
    const namespace = `rtac-redis-${randomUUID()}`;
    const writer = new ReadThroughAllCache<string>(namespace, 60_000);
    const reader = new ReadThroughAllCache<string>(namespace, 60_000);

    await writer.set('user-1', 'stale-soon');
    await writer.invalidateAll();

    /** The reader never memoized the pre-invalidation value, so its read must
     *  miss through Redis under the new generation. */
    await expect(reader.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));

    await writer.set('user-1', 'fresh');
    await expect(reader.get('user-1')).resolves.toEqual({ hit: true, value: 'fresh' });
  });

  test('stores per-user entries under distinct keys in Redis', async () => {
    const { ReadThroughAllCache } = await import('../ReadThroughAllCache');
    const namespace = `rtac-redis-${randomUUID()}`;
    const cache = new ReadThroughAllCache<string>(namespace, 60_000);

    await cache.set('user-1', 'a');
    await cache.set('user-2', 'b');

    const { ioredisClient } = await import('~/cache/redisClients');
    if (!ioredisClient) {
      throw new Error('ioredisClient is null');
    }
    const keys = await ioredisClient.keys(`${testPrefix}*${namespace}*`);
    expect(keys.some((key) => key.includes('user-1'))).toBe(true);
    expect(keys.some((key) => key.includes('user-2'))).toBe(true);
  });

  test('with transforms, the shared store only ever holds ciphertext', async () => {
    const { ReadThroughAllCache } = await import('../ReadThroughAllCache');
    const namespace = `rtac-redis-${randomUUID()}`;
    const transforms = {
      encode: (value: string) => `enc:${Buffer.from(value).toString('base64')}`,
      decode: (raw: string) => Buffer.from(raw.slice(4), 'base64').toString('utf8'),
    };
    const writer = new ReadThroughAllCache<string>(namespace, 60_000, transforms);
    const reader = new ReadThroughAllCache<string>(namespace, 60_000, transforms);
    /** A reader without transforms returns whatever the shared store holds. */
    const plainReader = new ReadThroughAllCache<string>(namespace, 60_000);

    await writer.set('user-1', 'super-secret-credential');

    await expect(reader.get('user-1')).resolves.toEqual({
      hit: true,
      value: 'super-secret-credential',
    });

    const stored = await plainReader.get('user-1');
    expect(stored).toEqual({ hit: true, value: expect.stringContaining('enc:') });
    expect(stored.value).not.toBe('super-secret-credential');
  });
});
