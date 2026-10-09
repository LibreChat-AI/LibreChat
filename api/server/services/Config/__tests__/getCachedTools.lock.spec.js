const { CacheKeys } = require('librechat-data-provider');
const calculateSlot = require('cluster-key-slot');

const mockRedisClient = {
  set: jest.fn(),
  eval: jest.fn(),
};
const mockKeyvRedisClient = {
  eval: jest.fn(),
};
let mockRedisReadyPromise = Promise.resolve();
const mockRedisReady = {
  then: (...args) => mockRedisReadyPromise.then(...args),
};
const mockWaitForRedis = jest.fn(() => mockRedisReady);

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  cacheConfig: { FORCED_IN_MEMORY_CACHE_NAMESPACES: [] },
  evalKeyvRedisScript: (...args) => mockKeyvRedisClient.eval(...args),
  mcpConfig: { USER_CONNECTION_IDLE_TIMEOUT: 15 * 60 * 1000 },
  ioredisClient: mockRedisClient,
  keyvRedisClient: mockKeyvRedisClient,
  waitForKeyvRedisClient: mockWaitForRedis,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

jest.mock('~/cache/getLogStores', () => jest.fn());

const getLogStores = require('~/cache/getLogStores');
const mockCache = { get: jest.fn(), set: jest.fn(), delete: jest.fn() };
getLogStores.mockReturnValue(mockCache);

const {
  getCachedTools,
  updateCachedGlobalTools,
  getMCPToolsCacheGeneration,
  setCachedTools,
  setCachedToolsIfCurrent,
  runWithGlobalCacheLock,
  invalidateCachedTools,
  setCachedToolsWithinGlobalLock,
  getNextAppToolsPublicationRevision,
  setCachedAppServerTools,
} = require('../getCachedTools');

describe('global tool cache write lock', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisReadyPromise = Promise.resolve();
    mockRedisClient.set.mockResolvedValue('OK');
    mockRedisClient.eval.mockResolvedValue(1);
    mockKeyvRedisClient.eval.mockResolvedValue(1);
    mockCache.set.mockResolvedValue(true);
    mockCache.delete.mockResolvedValue(true);
  });

  it('waits for the shared Redis client before accessing the catalog', async () => {
    mockCache.get.mockResolvedValue(null);
    let resolveRedisReady;
    mockRedisReadyPromise = new Promise((resolve) => {
      resolveRedisReady = resolve;
    });

    const update = updateCachedGlobalTools(() => ({ builtin: {} }));
    await Promise.resolve();

    expect(mockRedisClient.set).not.toHaveBeenCalled();
    expect(mockCache.get).not.toHaveBeenCalled();

    resolveRedisReady();
    await expect(update).resolves.toBeUndefined();

    expect(mockRedisClient.set).toHaveBeenCalledTimes(1);
    expect(mockCache.get).toHaveBeenCalledWith('tools:global');
  });

  it('waits for the shared Redis client before reading the catalog', async () => {
    mockCache.get.mockResolvedValue({ builtin: {} });
    let resolveRedisReady;
    mockRedisReadyPromise = new Promise((resolve) => {
      resolveRedisReady = resolve;
    });

    const read = getCachedTools();
    await Promise.resolve();

    expect(mockCache.get).not.toHaveBeenCalled();

    resolveRedisReady();
    await expect(read).resolves.toEqual({ builtin: {} });
    expect(mockCache.get).toHaveBeenCalledWith('tools:global');
  });

  it('acquires and safely releases the Redis lock around an aggregate update', async () => {
    const operation = jest.fn().mockResolvedValue('updated');

    await expect(runWithGlobalCacheLock(operation)).resolves.toBe('updated');

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      `${CacheKeys.TOOL_CACHE}:tools:global:write-lock`,
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
    const token = mockRedisClient.set.mock.calls[0][1];
    expect(mockRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET'"),
      1,
      `${CacheKeys.TOOL_CACHE}:tools:global:write-lock`,
      token,
    );
    const fenceKey = mockKeyvRedisClient.eval.mock.calls[0][1].keys[0];
    expect(calculateSlot(fenceKey)).toBe(calculateSlot(`${CacheKeys.TOOL_CACHE}:tools:global`));
  });

  it('releases the Redis lock when the aggregate update fails', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('cache read failed'));

    await expect(runWithGlobalCacheLock(operation)).rejects.toThrow('cache read failed');

    expect(mockRedisClient.eval).toHaveBeenCalledTimes(1);
  });

  it('serializes direct global writes and invalidation', async () => {
    await setCachedTools({ builtin: {} });
    await invalidateCachedTools({ invalidateGlobal: true });

    expect(mockRedisClient.set).toHaveBeenCalledTimes(2);
    expect(mockRedisClient.eval).toHaveBeenCalledTimes(2);
  });

  it('does not reacquire the lock for a write already inside an aggregate update', async () => {
    await runWithGlobalCacheLock(() => setCachedToolsWithinGlobalLock({ mcp: {} }));

    expect(mockRedisClient.set).toHaveBeenCalledTimes(1);
    expect(mockRedisClient.eval).toHaveBeenCalledTimes(1);
    expect(mockKeyvRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      expect.objectContaining({
        keys: [
          `tools:global:write-fence:{${CacheKeys.TOOL_CACHE}:tools:global}`,
          `${CacheKeys.TOOL_CACHE}:tools:global`,
        ],
      }),
    );
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('atomically replaces a legacy global catalog while holding its Redis fence', async () => {
    mockCache.get.mockResolvedValue({ old_mcp_server: {}, builtin: {} });

    await updateCachedGlobalTools(() => ({ builtin: {} }));

    expect(mockRedisClient.set).toHaveBeenCalledTimes(1);
    expect(mockKeyvRedisClient.eval).toHaveBeenCalledTimes(3);
    expect(mockKeyvRedisClient.eval.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.stringContaining("redis.call('PSETEX', KEYS[2]"),
          expect.objectContaining({
            keys: [
              `tools:global:write-fence:{${CacheKeys.TOOL_CACHE}:tools:global}`,
              `${CacheKeys.TOOL_CACHE}:tools:global`,
            ],
            arguments: [
              expect.any(String),
              JSON.stringify({ builtin: {} }),
              expect.any(String),
              expect.any(String),
            ],
          }),
        ],
      ]),
    );
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('rejects a Redis-backed global write made without distributed lock ownership', async () => {
    await expect(setCachedToolsWithinGlobalLock({ unsafe: {} })).rejects.toThrow(
      'Global tool cache write requires lock ownership',
    );

    expect(mockCache.set).not.toHaveBeenCalled();
    expect(mockKeyvRedisClient.eval).not.toHaveBeenCalled();
  });

  it('rejects a delayed global write after its distributed lease is lost', async () => {
    mockKeyvRedisClient.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValue(1);

    await expect(
      runWithGlobalCacheLock(() => setCachedToolsWithinGlobalLock({ stale: {} })),
    ).rejects.toThrow('Global tool cache lock ownership was lost before write');

    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('rejects a delayed ownership claim after a newer owner has fenced the slot', async () => {
    const operation = jest.fn();
    mockKeyvRedisClient.eval.mockResolvedValueOnce(0);

    await expect(runWithGlobalCacheLock(operation)).rejects.toThrow(
      'Tool cache lock expired or was superseded before ownership could be fenced',
    );

    expect(operation).not.toHaveBeenCalled();
    const [claimScript, claimOptions] = mockKeyvRedisClient.eval.mock.calls[0];
    expect(claimScript).toContain('current ~= ARGV[1]');
    expect(claimScript).toContain("redis.call('TIME')");
    expect(claimOptions.arguments).toEqual([
      mockRedisClient.set.mock.calls[0][1],
      expect.any(String),
      '1000',
    ]);
  });

  it('atomically checks the generation and writes a generation-guarded user catalog', async () => {
    await expect(
      setCachedToolsIfCurrent(
        { current: {} },
        {
          userId: 'user-1',
          serverName: 'server-1',
          configGeneration: 'config-current',
          publicationGeneration: 'generation-current',
        },
      ),
    ).resolves.toBe(true);

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      `${CacheKeys.TOOL_CACHE}:tools:mcp-write-lock:user-1:server-1`,
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
    expect(mockRedisClient.eval).toHaveBeenCalledTimes(1);
    expect(mockKeyvRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('PSETEX', KEYS[2]"),
      expect.objectContaining({
        keys: [
          `${CacheKeys.TOOL_CACHE}:tools:metadata:mcp:user-generation:{user-1:server-1}`,
          `${CacheKeys.TOOL_CACHE}:tools:mcp:user:{user-1:server-1}:v2:config-current`,
        ],
        arguments: [
          'generation-current',
          expect.any(String),
          expect.any(String),
          expect.stringContaining('"publicationGeneration":"generation-current"'),
          expect.any(String),
          expect.any(String),
        ],
      }),
    );
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('does not write tools when the atomic generation check observes a replacement', async () => {
    mockKeyvRedisClient.eval.mockResolvedValue(0);

    await expect(
      setCachedToolsIfCurrent(
        { stale: {} },
        {
          userId: 'user-1',
          serverName: 'server-1',
          configGeneration: 'config-old',
          publicationGeneration: 'generation-old',
        },
      ),
    ).resolves.toBe(false);

    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('orders app snapshots atomically in the app catalog Redis slot', async () => {
    mockCache.get.mockResolvedValue(null);
    mockKeyvRedisClient.eval
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const older = await getNextAppToolsPublicationRevision('server-1', 'config-current');
    const newer = await getNextAppToolsPublicationRevision('server-1', 'config-current');
    await expect(
      setCachedAppServerTools('server-1', 'config-current', { current: {} }, newer),
    ).resolves.toBe(true);
    await expect(
      setCachedAppServerTools('server-1', 'config-current', { stale: {} }, older),
    ).resolves.toBe(false);

    const [reserveScript, reserveOptions] = mockKeyvRedisClient.eval.mock.calls[0];
    const [writeScript, writeOptions] = mockKeyvRedisClient.eval.mock.calls[2];
    expect(reserveScript).toContain("redis.call('INCR', KEYS[1])");
    expect(writeScript).toContain('tonumber(current) > tonumber(ARGV[1])');
    expect(writeScript).toContain("currentEntry['value']['publicationRevision']");
    expect(calculateSlot(reserveOptions.keys[0])).toBe(calculateSlot(writeOptions.keys[1]));
    expect(calculateSlot(writeOptions.keys[0])).toBe(calculateSlot(writeOptions.keys[1]));
    expect(writeOptions.keys[0]).toContain('app-committed-revision');
    expect(writeOptions.keys[0]).not.toBe(reserveOptions.keys[0]);
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('serializes legacy user catalog migration with Redis-backed writers', async () => {
    const legacy = { legacy: {} };
    mockCache.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacy)
      .mockResolvedValueOnce('generation-current')
      .mockResolvedValueOnce('generation-current');

    await expect(
      getCachedTools({
        userId: 'user-1',
        serverName: 'server-1',
        configGeneration: 'config-current',
      }),
    ).resolves.toBe(legacy);

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      `${CacheKeys.TOOL_CACHE}:tools:mcp-write-lock:user-1:server-1`,
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
    expect(mockKeyvRedisClient.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXISTS', KEYS[2])"),
      expect.objectContaining({
        keys: [
          `tools:mcp:write-fence:{user-1:server-1}`,
          `${CacheKeys.TOOL_CACHE}:tools:metadata:mcp:user-legacy-fence:{user-1:server-1}`,
          `${CacheKeys.TOOL_CACHE}:tools:metadata:mcp:user-generation:{user-1:server-1}`,
          `${CacheKeys.TOOL_CACHE}:tools:mcp:user:{user-1:server-1}:v2:config-current`,
        ],
      }),
    );
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('rejects first-generation creation after its distributed lock ownership is lost', async () => {
    mockCache.get.mockResolvedValue(null);
    mockKeyvRedisClient.eval
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(-1)
      .mockResolvedValue(1);

    await expect(
      getMCPToolsCacheGeneration({ userId: 'user-1', serverName: 'server-1' }),
    ).rejects.toThrow('Tool cache lock ownership was lost before generation creation');

    const createCall = mockKeyvRedisClient.eval.mock.calls.find(([script]) =>
      script.includes("redis.call('EXISTS', KEYS[2])"),
    );
    expect(calculateSlot(createCall[1].keys[0])).toBe(calculateSlot(createCall[1].keys[1]));
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('waits through the full abandoned Redis lease before giving up', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    mockRedisClient.set.mockImplementation(async () =>
      Date.now() - startedAt >= 30_000 ? 'OK' : null,
    );
    const operation = jest.fn().mockResolvedValue('recovered');

    const result = runWithGlobalCacheLock(operation);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(operation).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(25_100);
    await expect(result).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
