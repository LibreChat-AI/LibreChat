import { CacheKeys } from 'librechat-data-provider';

const mockKeyvRedisInstance = {
  namespace: '',
  keyPrefixSeparator: '',
  on: jest.fn(),
};

const MockKeyvRedis = jest.fn().mockReturnValue(mockKeyvRedisInstance);

jest.mock('@keyv/redis', () => ({
  default: MockKeyvRedis,
}));

const mockKeyvRedisClient = { scanIterator: jest.fn() };

jest.mock('../../redisClients', () => ({
  handleKeyvRedisError: jest.fn(),
  keyvRedisClient: mockKeyvRedisClient,
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

describe('standardCache - CONFIG_STORE vs TOOL_CACHE namespace isolation', () => {
  afterEach(() => {
    jest.resetModules();
    MockKeyvRedis.mockClear();
  });

  /**
   * Core behavioral test for blue/green deployments:
   * When CONFIG_STORE and APP_CONFIG are forced in-memory,
   * TOOL_CACHE should still use Redis for cross-container sharing.
   */
  it('should force CONFIG_STORE to in-memory while TOOL_CACHE uses Redis', async () => {
    jest.doMock('../../cacheConfig', () => ({
      cacheConfig: {
        FORCED_IN_MEMORY_CACHE_NAMESPACES: [CacheKeys.CONFIG_STORE, CacheKeys.APP_CONFIG],
        REDIS_KEY_PREFIX: '',
        GLOBAL_PREFIX_SEPARATOR: '>>',
      },
    }));

    const { standardCache } = await import('../../cacheFactory');

    MockKeyvRedis.mockClear();

    const configCache = standardCache(CacheKeys.CONFIG_STORE);
    expect(MockKeyvRedis).not.toHaveBeenCalled();
    expect(configCache).toBeDefined();

    const appConfigCache = standardCache(CacheKeys.APP_CONFIG);
    expect(MockKeyvRedis).not.toHaveBeenCalled();
    expect(appConfigCache).toBeDefined();

    const toolCache = standardCache(CacheKeys.TOOL_CACHE);
    expect(MockKeyvRedis).toHaveBeenCalledTimes(1);
    expect(MockKeyvRedis).toHaveBeenCalledWith(mockKeyvRedisClient);
    expect(toolCache).toBeDefined();
  });

  it('CONFIG_STORE and TOOL_CACHE should be independent stores', async () => {
    jest.doMock('../../cacheConfig', () => ({
      cacheConfig: {
        FORCED_IN_MEMORY_CACHE_NAMESPACES: [CacheKeys.CONFIG_STORE],
        REDIS_KEY_PREFIX: '',
        GLOBAL_PREFIX_SEPARATOR: '>>',
      },
    }));

    const { standardCache } = await import('../../cacheFactory');

    const configCache = standardCache(CacheKeys.CONFIG_STORE);
    const toolCache = standardCache(CacheKeys.TOOL_CACHE);

    await configCache.set('STARTUP_CONFIG', { version: 'v2-green' });
    await toolCache.set('tools:global', { myTool: { type: 'function' } });

    expect(await configCache.get('STARTUP_CONFIG')).toEqual({ version: 'v2-green' });
    expect(await configCache.get('tools:global')).toBeUndefined();

    expect(await toolCache.get('STARTUP_CONFIG')).toBeUndefined();
  });

  it('should use Redis for all namespaces when nothing is forced in-memory', async () => {
    jest.doMock('../../cacheConfig', () => ({
      cacheConfig: {
        FORCED_IN_MEMORY_CACHE_NAMESPACES: [],
        REDIS_KEY_PREFIX: '',
        GLOBAL_PREFIX_SEPARATOR: '>>',
      },
    }));

    const { standardCache } = await import('../../cacheFactory');

    MockKeyvRedis.mockClear();

    standardCache(CacheKeys.CONFIG_STORE);
    standardCache(CacheKeys.TOOL_CACHE);
    standardCache(CacheKeys.APP_CONFIG);

    expect(MockKeyvRedis).toHaveBeenCalledTimes(3);
  });

  it('forcing TOOL_CACHE to in-memory should not affect CONFIG_STORE', async () => {
    jest.doMock('../../cacheConfig', () => ({
      cacheConfig: {
        FORCED_IN_MEMORY_CACHE_NAMESPACES: [CacheKeys.TOOL_CACHE],
        REDIS_KEY_PREFIX: '',
        GLOBAL_PREFIX_SEPARATOR: '>>',
      },
    }));

    const { standardCache } = await import('../../cacheFactory');

    MockKeyvRedis.mockClear();

    standardCache(CacheKeys.TOOL_CACHE);
    expect(MockKeyvRedis).not.toHaveBeenCalled();

    standardCache(CacheKeys.CONFIG_STORE);
    expect(MockKeyvRedis).toHaveBeenCalledTimes(1);
  });
});
