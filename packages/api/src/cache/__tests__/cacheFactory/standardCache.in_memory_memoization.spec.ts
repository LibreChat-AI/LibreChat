import { CacheKeys, Time } from 'librechat-data-provider';

jest.mock('@keyv/redis', () => ({
  default: jest.fn(),
}));

jest.mock('../../redisClients', () => ({
  handleKeyvRedisError: jest.fn(),
  keyvRedisClient: null,
  ioredisClient: null,
}));

jest.mock('../../redisUtils', () => ({
  batchDeleteKeys: jest.fn(),
  scanKeys: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('standardCache - in-memory memoization', () => {
  afterEach(() => {
    jest.resetModules();
  });

  async function loadFactory() {
    jest.doMock('../../cacheConfig', () => ({
      cacheConfig: {
        FORCED_IN_MEMORY_CACHE_NAMESPACES: [],
        REDIS_KEY_PREFIX: '',
        GLOBAL_PREFIX_SEPARATOR: '>>',
      },
    }));
    return import('../../cacheFactory');
  }

  it('returns the same instance for repeated calls with the same namespace', async () => {
    const { standardCache } = await loadFactory();
    const a = standardCache('test-ns');
    const b = standardCache('test-ns');
    expect(a).toBe(b);
  });

  it('returns different instances for different namespaces', async () => {
    const { standardCache } = await loadFactory();
    const a = standardCache('ns-one');
    const b = standardCache('ns-two');
    expect(a).not.toBe(b);
  });

  it('shares data across separate standardCache calls for the same namespace', async () => {
    const { standardCache } = await loadFactory();
    const writer = standardCache(CacheKeys.TOKEN_CONFIG);
    await writer.set('model-a', { context: 128000 });

    const reader = standardCache(CacheKeys.TOKEN_CONFIG);
    expect(await reader.get('model-a')).toEqual({ context: 128000 });
  });

  it('does not leak data between different namespaces', async () => {
    const { standardCache } = await loadFactory();
    const cacheA = standardCache('ns-a');
    const cacheB = standardCache('ns-b');

    await cacheA.set('key', 'value-a');
    await cacheB.set('key', 'value-b');

    expect(await cacheA.get('key')).toBe('value-a');
    expect(await cacheB.get('key')).toBe('value-b');
  });

  it('first caller TTL wins for a given namespace', async () => {
    const { standardCache } = await loadFactory();
    const first = standardCache('ttl-ns', 500);
    const second = standardCache('ttl-ns', 99999);
    expect(first).toBe(second);

    type KeyvWithOpts = typeof first & { opts: { ttl?: number } };
    expect((first as KeyvWithOpts).opts.ttl).toBe(500);
  });

  it('does not memoize when a custom fallbackStore is provided', async () => {
    const { standardCache } = await loadFactory();
    const storeA = new Map();
    const storeB = new Map();
    const a = standardCache('fb-ns', undefined, storeA);
    const b = standardCache('fb-ns', undefined, storeB);
    expect(a).not.toBe(b);
  });

  it('tokenConfigCache shares data with standardCache(TOKEN_CONFIG)', async () => {
    const { standardCache, tokenConfigCache } = await loadFactory();
    const direct = standardCache(CacheKeys.TOKEN_CONFIG, Time.THIRTY_MINUTES);
    await direct.set('openrouter', { 'gpt-4': { context: 128000, prompt: 5, completion: 15 } });

    const convenience = tokenConfigCache();
    expect(await convenience.get('openrouter')).toEqual({
      'gpt-4': { context: 128000, prompt: 5, completion: 15 },
    });
    expect(convenience).toBe(direct);
  });

  it('tokenConfigCache creates the instance with THIRTY_MINUTES TTL', async () => {
    const { tokenConfigCache } = await loadFactory();
    const cache = tokenConfigCache();
    type KeyvWithOpts = typeof cache & { opts: { ttl?: number } };
    expect((cache as KeyvWithOpts).opts.ttl).toBe(Time.THIRTY_MINUTES);
  });
});
