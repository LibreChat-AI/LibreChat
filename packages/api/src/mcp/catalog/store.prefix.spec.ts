import { CacheKeys } from 'librechat-data-provider';
import type { CatalogStoreDeps } from './store';
import { createMCPCatalogStore } from './store';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('createMCPCatalogStore Redis key prefixing', () => {
  it('applies REDIS_KEY_PREFIX to globalFenceKey and user fenceKey', async () => {
    const evaluatedKeys: string[] = [];
    const mockKeyvRedis = {
      eval: jest.fn().mockImplementation((script: string, options: { keys: string[] }) => {
        if (options?.keys) {
          evaluatedKeys.push(...options.keys);
        }
        return 1;
      }),
    };
    const mockIoredis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };

    const store = createMCPCatalogStore({
      cacheConfig: {
        REDIS_KEY_PREFIX: 'test-env',
        GLOBAL_PREFIX_SEPARATOR: '::',
      },
      keyvRedisClient: mockKeyvRedis as unknown as CatalogStoreDeps['keyvRedisClient'],
      ioredisClient: mockIoredis as unknown as CatalogStoreDeps['ioredisClient'],
      getCache: () => ({
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(true),
        delete: jest.fn(),
      }),
    });

    // 1. Global lock & fence
    await store.runWithGlobalCacheLock(async () => 'ok');

    expect(evaluatedKeys.length).toBeGreaterThan(0);
    const globalFence = evaluatedKeys.find((k) => k.includes('tools:global:write-fence'));
    expect(globalFence).toBeDefined();
    expect(globalFence?.startsWith('test-env::')).toBe(true);
    expect(globalFence).toContain(CacheKeys.TOOL_CACHE);

    // 2. User queue lock & fence
    await store.getMCPToolsCacheGeneration({ userId: 'u1', serverName: 'srv1' });

    const userFence = evaluatedKeys.find((k) => k.includes('tools:mcp:write-fence'));
    expect(userFence).toBeDefined();
    expect(userFence?.startsWith('test-env::')).toBe(true);
    expect(userFence).toContain(CacheKeys.TOOL_CACHE);
  });
});
