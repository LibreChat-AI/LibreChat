import { getMaxSubagents, setMaxSubagents } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ConfigGenerationChange } from './reload';
import {
  createAppConfigService,
  _resetOverrideStrictCache,
  getAppConfigOptionsFromUser,
} from './service';
import { createConfigReloader, createConfigGenerationTracker, hashConfig } from './reload';

function modelConfig(model: string): TCustomConfig {
  return {
    version: '1',
    configReload: { clusterReady: true },
    endpoints: {
      custom: [
        {
          name: 'gateway',
          apiKey: 'user_provided',
          baseURL: 'https://example.com',
          models: { default: [model], fetch: false },
        },
      ],
    },
  };
}

function modelAppConfig(model: string): AppConfig {
  const config = modelConfig(model);
  return { config, endpoints: config.endpoints } as AppConfig;
}

/** Extends AppConfig with mock fields used by merge behavior tests. */
interface TestConfig extends AppConfig {
  restricted?: boolean;
  x?: string;
}

/**
 * Creates a mock cache that simulates Keyv's namespace behavior.
 * Keyv stores keys internally as `namespace:key` but its API (get/set/delete)
 * accepts un-namespaced keys and auto-prepends the namespace.
 */
function createMockCache(namespace = 'app_config') {
  const store = new Map();
  return {
    get: jest.fn((key) => Promise.resolve(store.get(`${namespace}:${key}`))),
    set: jest.fn((key, value) => {
      store.set(`${namespace}:${key}`, value);
      return Promise.resolve(undefined);
    }),
    delete: jest.fn((key) => {
      store.delete(`${namespace}:${key}`);
      return Promise.resolve(true);
    }),
    /** Mimic Keyv's opts.store structure for key enumeration in clearOverrideCache */
    opts: { store: { keys: () => store.keys() } } as {
      store?: { keys: () => IterableIterator<string> };
    },
    _store: store,
  };
}

function createDeps(overrides = {}) {
  const cache = createMockCache();
  const baseConfig = { interfaceConfig: { modelSelect: true }, endpoints: ['openAI'] };

  return {
    loadBaseConfig: jest.fn().mockResolvedValue(baseConfig),
    setCachedTools: jest.fn().mockResolvedValue(undefined),
    getCache: jest.fn().mockReturnValue(cache),
    cacheKeys: { APP_CONFIG: 'app_config' },
    getApplicableConfigs: jest.fn().mockResolvedValue([]),
    getUserPrincipals: jest.fn().mockResolvedValue([
      { principalType: 'role', principalId: 'USER' },
      { principalType: 'user', principalId: 'uid1' },
    ]),
    _cache: cache,
    _baseConfig: baseConfig,
    ...overrides,
  };
}

describe('createAppConfigService', () => {
  describe('getAppConfig', () => {
    it('loads base config on first call', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig();

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
      expect(deps.loadBaseConfig).toHaveBeenCalledWith('startup', undefined);
      expect(config).toEqual(deps._baseConfig);
    });

    it('reads the persisted generation before the startup source', async () => {
      const beforeInitialLoad = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({ bootstrapConfigGeneration: beforeInitialLoad });
      const { getAppConfig } = createAppConfigService(deps);
      await getAppConfig({ baseOnly: true });

      expect(beforeInitialLoad).toHaveBeenCalledTimes(1);
      expect(beforeInitialLoad.mock.invocationCallOrder[0]).toBeLessThan(
        deps.loadBaseConfig.mock.invocationCallOrder[0],
      );
      await getAppConfig({ baseOnly: true });
      expect(beforeInitialLoad).toHaveBeenCalledTimes(1);
    });

    it('keeps startup config available when the optional Redis baseline fails', async () => {
      const deps = createDeps({
        bootstrapConfigGeneration: jest.fn().mockRejectedValue(new Error('Redis reconnecting')),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ baseOnly: true })).resolves.toEqual(deps._baseConfig);
      expect(deps.loadBaseConfig).toHaveBeenCalledWith('startup', undefined);
    });

    it('does not publish startup-only tool definitions from live reloads', async () => {
      const tools = { calculator: { type: 'function' } };
      const deps = createDeps({
        loadBaseConfig: jest
          .fn()
          .mockResolvedValue({ availableTools: tools, config: { version: '1' } }),
      });
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);
      await getAppConfig({ baseOnly: true });
      expect(deps.setCachedTools).toHaveBeenCalledTimes(1);
      await clearAppConfigCache();
      await getAppConfig({ baseOnly: true });
      expect(deps.setCachedTools).toHaveBeenCalledTimes(1);
    });

    it('publishes a validated subagent cap only after the new base is committed', async () => {
      const oldCap = getMaxSubagents();
      try {
        const deps = createDeps({
          loadBaseConfig: jest
            .fn()
            .mockResolvedValueOnce({ config: { endpoints: { agents: { maxSubagents: 7 } } } })
            .mockResolvedValueOnce({ config: { endpoints: { agents: { maxSubagents: 20 } } } }),
        });
        const service = createAppConfigService(deps);
        await service.getAppConfig({ baseOnly: true });
        expect(getMaxSubagents()).toBe(7);
        let commit: (() => void) | undefined;
        deps._cache.set.mockImplementationOnce(
          () =>
            new Promise<undefined>((resolve) => {
              commit = () => resolve(undefined);
            }),
        );
        const pending = service.getAppConfig({ baseOnly: true, refresh: true });
        await new Promise((resolve) => setImmediate(resolve));
        expect(getMaxSubagents()).toBe(7);
        commit?.();
        await pending;
        expect(getMaxSubagents()).toBe(20);
      } finally {
        setMaxSubagents(oldCap);
      }
    });

    it('caches base config — does not reload on second call', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig();
      await getAppConfig();

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
    });

    it('baseOnly returns YAML config without DB queries', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([
            { priority: 10, overrides: { interface: { modelSelect: false } }, isActive: true },
          ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ baseOnly: true });

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
      expect(deps.getApplicableConfigs).not.toHaveBeenCalled();
      expect(config).toEqual(deps._baseConfig);
    });

    it('reloads base config when refresh is true', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig();
      await getAppConfig({ refresh: true });

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
      expect(deps.loadBaseConfig).toHaveBeenLastCalledWith('reload', expect.any(Object));
    });

    it.each(['invalid YAML', 'missing local file', 'remote fetch failure'])(
      'keeps the last good base config when reload fails: %s',
      async (message) => {
        const deps = createDeps();
        const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);
        const initial = await getAppConfig({ baseOnly: true });
        deps.loadBaseConfig.mockRejectedValueOnce(new Error(message));

        await clearAppConfigCache();
        const reloaded = await getAppConfig({ baseOnly: true });

        expect(reloaded).toBe(initial);
        expect(deps._cache._store.get('app_config:_BASE_')).toBe(initial);
        expect(deps.loadBaseConfig).toHaveBeenLastCalledWith('reload', expect.any(Object));
      },
    );

    it('single-flights concurrent base config reloads', async () => {
      const deps = createDeps();
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      await clearAppConfigCache();

      let resolveReload: ((config: AppConfig) => void) | undefined;
      deps.loadBaseConfig.mockImplementationOnce(
        () =>
          new Promise<AppConfig>((resolve) => {
            resolveReload = resolve;
          }),
      );
      const reloads = Array.from({ length: 10 }, () => getAppConfig({ baseOnly: true }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);

      const next = { ...initial, interfaceConfig: { modelSelect: false } };
      resolveReload?.(next);
      await expect(Promise.all(reloads)).resolves.toEqual(Array(10).fill(next));
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });

    it('does not convert a startup load failure into an empty config', async () => {
      const failure = new Error('invalid startup config');
      const deps = createDeps({ loadBaseConfig: jest.fn().mockRejectedValue(failure) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ baseOnly: true })).rejects.toBe(failure);
      expect(deps.loadBaseConfig).toHaveBeenCalledWith('startup', undefined);
    });

    it('drops base and override entries when another replica publishes a generation', async () => {
      const syncConfigGeneration = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        syncConfigGeneration,
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 'old' }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);
      await getAppConfig({ role: 'USER' });
      const next = { ...deps._baseConfig, config: { version: '2.0' }, endpoints: ['new-endpoint'] };
      deps.loadBaseConfig.mockResolvedValueOnce(next);
      const acknowledge = jest.fn();
      syncConfigGeneration.mockResolvedValueOnce({
        expectedDigest: hashConfig(next.config),
        isCurrent: () => true,
        acknowledge,
        defer: jest.fn(),
      });

      await getAppConfig({ role: 'USER' });
      await new Promise((resolve) => setImmediate(resolve));
      const config = await getAppConfig({ role: 'USER' });

      expect(config.endpoints).toEqual(['new-endpoint']);
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect(deps.loadBaseConfig).toHaveBeenLastCalledWith('reload', expect.any(Object));
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('does not block an admin reload behind an offline generation read', async () => {
      const original = modelAppConfig('old-model');
      const syncConfigGeneration = jest.fn().mockResolvedValue(undefined);
      let releaseRead: ((change: undefined) => void) | undefined;
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue(original),
        syncConfigGeneration,
      });
      const service = createAppConfigService(deps);
      await service.getAppConfig({ baseOnly: true });
      syncConfigGeneration.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseRead = resolve;
          }),
      );
      await service.getAppConfig({ baseOnly: true });

      const reload = createConfigReloader({
        loadConfig: async () => modelConfig('new-model'),
        buildBaseConfig: async (source) => ({ ...original, config: source }),
        getBaseConfig: () => service.getAppConfig({ baseOnly: true }),
        replaceBaseConfig: service.replaceBaseConfig,
        clearOverrideCache: () => service.clearOverrideCache(),
        withConfigUpdate: service.withConfigUpdate,
        generation: {
          ...createConfigGenerationTracker(),
          distributed: true,
          snapshot: jest.fn().mockResolvedValue({ raw: null }),
          superseded: jest.fn().mockReturnValue(false),
          bump: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
        },
      });
      try {
        await expect(
          Promise.race([
            reload(),
            new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
          ]),
        ).resolves.toMatchObject({
          scope: 'local',
          propagationError: 'Redis generation update failed',
        });
        expect(
          (await service.getAppConfig({ baseOnly: true })).config.endpoints?.custom?.[0].models
            ?.default,
        ).toEqual(['new-model']);
      } finally {
        releaseRead?.(undefined);
      }
    });

    it('ignores an older generation after an admin publishes a newer local base', async () => {
      const original = modelAppConfig('old-model');
      const syncConfigGeneration = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue(original),
        syncConfigGeneration,
      });
      const service = createAppConfigService(deps);
      await service.getAppConfig({ baseOnly: true });
      let releaseRead: ((change: ConfigGenerationChange) => void) | undefined;
      let current = true;
      syncConfigGeneration.mockImplementationOnce(
        () =>
          new Promise<ConfigGenerationChange>((resolve) => {
            releaseRead = resolve;
          }),
      );
      await service.getAppConfig({ baseOnly: true });
      const acknowledge = jest.fn();
      const bump = jest.fn().mockImplementation(async () => {
        current = false;
        return 2;
      });
      const reload = createConfigReloader({
        loadConfig: async () => modelConfig('new-model'),
        buildBaseConfig: async (source) => ({ ...original, config: source }),
        getBaseConfig: () => service.getAppConfig({ baseOnly: true }),
        replaceBaseConfig: service.replaceBaseConfig,
        clearOverrideCache: () => service.clearOverrideCache(),
        withConfigUpdate: service.withConfigUpdate,
        generation: {
          ...createConfigGenerationTracker(),
          distributed: true,
          snapshot: jest.fn().mockResolvedValue({ raw: null }),
          superseded: jest.fn().mockReturnValue(false),
          bump,
        },
      });
      await reload();
      releaseRead?.({
        expectedDigest: hashConfig(modelConfig('remote-model')),
        isCurrent: () => current,
        acknowledge,
        defer: jest.fn(),
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        (await service.getAppConfig({ baseOnly: true })).config.endpoints?.custom?.[0].models
          ?.default,
      ).toEqual(['new-model']);
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
      expect(acknowledge).not.toHaveBeenCalled();
    });

    it('serializes a background generation with a concurrent admin reload', async () => {
      const original = modelAppConfig('old-model');
      const remote = modelAppConfig('remote-model');
      let resolveRemote: ((config: AppConfig) => void) | undefined;
      const loadBaseConfig = jest
        .fn()
        .mockResolvedValueOnce(original)
        .mockImplementationOnce(
          () =>
            new Promise<AppConfig>((resolve) => {
              resolveRemote = resolve;
            }),
        );
      const syncConfigGeneration = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({ loadBaseConfig, syncConfigGeneration });
      const service = createAppConfigService(deps);
      await service.getAppConfig({ baseOnly: true });
      syncConfigGeneration.mockResolvedValueOnce({
        expectedDigest: hashConfig(remote.config),
        isCurrent: () => true,
        acknowledge: jest.fn(),
        defer: jest.fn(),
      });
      await service.getAppConfig({ baseOnly: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(resolveRemote).toBeDefined();

      const loadConfig = jest.fn().mockResolvedValue(modelConfig('new-model'));
      const bump = jest.fn().mockResolvedValue(2);
      const adminReload = createConfigReloader({
        loadConfig,
        buildBaseConfig: async (source) => ({ ...original, config: source }),
        getBaseConfig: () => service.getAppConfig({ baseOnly: true }),
        replaceBaseConfig: service.replaceBaseConfig,
        clearOverrideCache: () => service.clearOverrideCache(),
        withConfigUpdate: service.withConfigUpdate,
        generation: {
          ...createConfigGenerationTracker(),
          distributed: true,
          snapshot: jest.fn().mockResolvedValue({ raw: null }),
          superseded: jest.fn().mockReturnValue(false),
          bump,
        },
      });
      const pendingAdmin = adminReload();
      await new Promise((resolve) => setImmediate(resolve));
      expect(loadConfig).not.toHaveBeenCalled();
      resolveRemote?.(remote);
      await expect(pendingAdmin).resolves.toMatchObject({ scope: 'cluster', generation: 2 });
      expect(
        (await service.getAppConfig({ baseOnly: true })).config.endpoints?.custom?.[0].models
          ?.default,
      ).toEqual(['new-model']);
      expect(bump).toHaveBeenCalledTimes(1);
    });

    it('does not acknowledge a generation until its source reload succeeds', async () => {
      const syncConfigGeneration = jest.fn().mockResolvedValue(undefined);
      const deps = createDeps({ syncConfigGeneration });
      const { getAppConfig } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      const acknowledge = jest.fn();
      const next = { ...initial, config: { version: '2.0' } };
      const change = {
        expectedDigest: hashConfig(next.config),
        isCurrent: () => true,
        acknowledge,
      };
      let published = true;
      syncConfigGeneration.mockImplementation(async () => (published ? change : undefined));
      deps.loadBaseConfig.mockRejectedValueOnce(new Error('remote unavailable'));
      await getAppConfig({ baseOnly: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(acknowledge).not.toHaveBeenCalled();
      expect((await getAppConfig({ baseOnly: true })).config).toBe(initial.config);

      deps.loadBaseConfig.mockResolvedValue(next);
      let recovered = await getAppConfig({ baseOnly: true });
      for (let attempt = 0; attempt < 10 && recovered.config?.version !== '2.0'; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
        recovered = await getAppConfig({ baseOnly: true });
      }
      expect(recovered.config).toEqual(next.config);
      expect(acknowledge).toHaveBeenCalled();
      published = false;
    });

    it('serves a cached base without waiting for an unavailable Redis generation check', async () => {
      const check = jest.fn(() => new Promise<undefined>(() => undefined));
      const deps = createDeps({ syncConfigGeneration: check });
      const { getAppConfig } = createAppConfigService(deps);
      await getAppConfig({ baseOnly: true });

      await expect(getAppConfig({ baseOnly: true })).resolves.toMatchObject(deps._baseConfig);
      expect(check).toHaveBeenCalledTimes(1);
    });

    it('does not cache a merged override produced from an older base revision', async () => {
      let resolveQuery: ((configs: []) => void) | undefined;
      const getApplicableConfigs = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<[]>((resolve) => {
              resolveQuery = resolve;
            }),
        )
        .mockResolvedValue([]);
      const deps = createDeps({ getApplicableConfigs });
      const { getAppConfig, replaceBaseConfig } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      const staleRead = getAppConfig({ role: 'USER' });
      await new Promise((resolve) => setImmediate(resolve));
      const next = { ...initial, interfaceConfig: { modelSelect: false } };
      await replaceBaseConfig(next);
      resolveQuery?.([]);

      const result = await staleRead;
      expect(result.interfaceConfig?.modelSelect).toBe(false);
      expect(getApplicableConfigs).toHaveBeenCalledTimes(2);
      expect(deps._cache._store.get('app_config:_OVERRIDE_:__default__:USER')).toBeUndefined();
    });

    it('installs a validated base config without re-reading its source', async () => {
      const deps = createDeps();
      const { getAppConfig, replaceBaseConfig } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      const next = { ...initial, interfaceConfig: { modelSelect: false } };

      await replaceBaseConfig(next);
      const config = await getAppConfig({ baseOnly: true });

      expect(config).toBe(next);
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
    });

    it('queries DB for applicable configs', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN' });

      expect(deps.getApplicableConfigs).toHaveBeenCalled();
    });

    it('materializes inferred model-spec endpoints in the base config', async () => {
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue({
          modelSpecs: {
            enforce: false,
            prioritize: true,
            list: [{ name: 'agent-spec', label: 'Agent Spec', preset: { agent_id: 'agent_abc' } }],
          },
        }),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ baseOnly: true });

      expect(config.modelSpecs?.list?.[0]?.preset?.endpoint).toBe('agents');
    });

    /**
     * Admin-panel specs arrive through DB override documents the base config
     * never saw, so materialization must also run on the merged result.
     */
    it('materializes inferred model-spec endpoints contributed by DB overrides', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            priority: 10,
            isActive: true,
            overrides: {
              modelSpecs: {
                list: [
                  { name: 'agent-spec', label: 'Agent Spec', preset: { agent_id: 'agent_abc' } },
                ],
              },
            },
          },
        ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = (await getAppConfig({ role: 'USER' })) as TestConfig;

      expect(config.modelSpecs?.list?.[0]?.preset?.endpoint).toBe('agents');
      expect(config.modelSpecs?.list?.[0]?.preset?.agent_id).toBe('agent_abc');
    });

    it('caches empty result — does not re-query DB on second call', async () => {
      const deps = createDeps({ getApplicableConfigs: jest.fn().mockResolvedValue([]) });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER' });
      await getAppConfig({ role: 'USER' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });

    it('merges DB configs when found', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([
            { priority: 10, overrides: { interface: { modelSelect: false } }, isActive: true },
          ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'ADMIN' });

      const merged = config as TestConfig;
      expect(merged.interfaceConfig?.modelSelect).toBe(false);
      expect(merged.endpoints).toEqual(['openAI']);
    });

    it('caches merged result with TTL', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN' });
      await getAppConfig({ role: 'ADMIN' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });

    it('uses separate cache keys per userId (no cross-user contamination)', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([
            { priority: 100, overrides: { x: 'user-specific' }, isActive: true },
          ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ userId: 'uid1' });
      await getAppConfig({ userId: 'uid2' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('userId without role gets its own cache key', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 100, overrides: { y: 1 }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ userId: 'uid1' });

      const cachedKeys = [...deps._cache._store.keys()];
      const overrideKey = cachedKeys.find((k) => k.includes('_OVERRIDE_:'));
      expect(overrideKey).toBe('app_config:_OVERRIDE_:__default__:uid1');
    });

    it('tenantId is included in cache key to prevent cross-tenant contamination', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('base-only empty result does not block subsequent scoped queries with results', async () => {
      const mockGetConfigs = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ getApplicableConfigs: mockGetConfigs });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig();

      mockGetConfigs.mockResolvedValueOnce([
        { priority: 10, overrides: { restricted: true }, isActive: true },
      ]);
      const config = await getAppConfig({ role: 'ADMIN' });

      expect(mockGetConfigs).toHaveBeenCalledTimes(2);
      expect((config as TestConfig).restricted).toBe(true);
    });

    it('does not short-circuit other users when one user has no overrides', async () => {
      const mockGetConfigs = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ getApplicableConfigs: mockGetConfigs });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER' });
      expect(mockGetConfigs).toHaveBeenCalledTimes(1);

      mockGetConfigs.mockResolvedValueOnce([
        { priority: 10, overrides: { x: 'admin-only' }, isActive: true },
      ]);
      const config = await getAppConfig({ role: 'ADMIN' });

      expect(mockGetConfigs).toHaveBeenCalledTimes(2);
      expect((config as TestConfig).x).toBe('admin-only');
    });

    it('passes empty principals to getApplicableConfigs when buildPrincipals returns empty', async () => {
      const deps = createDeps({
        getUserPrincipals: jest.fn().mockResolvedValue([]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ userId: 'uid1', role: 'USER' });

      expect(deps.getUserPrincipals).toHaveBeenCalledWith({ userId: 'uid1', role: 'USER' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
      expect(config).toEqual(deps._baseConfig);
    });

    describe('strict mode (TENANT_ISOLATION_STRICT=true)', () => {
      beforeEach(() => {
        process.env.TENANT_ISOLATION_STRICT = 'true';
        _resetOverrideStrictCache();
      });
      afterEach(() => {
        delete process.env.TENANT_ISOLATION_STRICT;
        _resetOverrideStrictCache();
      });

      it('skips DB query for empty principals without tenantId and does not cache', async () => {
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        const config = await getAppConfig();

        expect(deps.getApplicableConfigs).not.toHaveBeenCalled();
        expect(config).toEqual(deps._baseConfig);

        const setCalls = deps._cache.set.mock.calls.filter(
          ([key]: [string, unknown]) => key !== '_BASE_',
        );
        expect(setCalls).toHaveLength(0);
      });

      it('queries DB when tenantId is present', async () => {
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        await getAppConfig({ tenantId: 'tenant-a' });

        expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
      });

      it('warns once when non-empty principals proceed without tenantId', async () => {
        const { logger } = jest.requireActual('@librechat/data-schemas');
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        await getAppConfig({ role: 'USER' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No tenantId in strict mode'));
        const warnCount = warnSpy.mock.calls.length;

        await getAppConfig({ role: 'ADMIN' });
        expect(warnSpy).toHaveBeenCalledTimes(warnCount);

        warnSpy.mockRestore();
      });

      it('falls through to getApplicableConfigs when ALS has tenant context despite no tenantId param', async () => {
        const { tenantStorage } = jest.requireActual('@librechat/data-schemas');
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockResolvedValue([{ priority: 5, overrides: { restricted: true }, isActive: true }]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        const config = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig(),
        );

        expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
        expect((config as TestConfig).restricted).toBe(true);
      });
    });

    describe('non-strict mode (TENANT_ISOLATION_STRICT unset)', () => {
      beforeEach(() => {
        delete process.env.TENANT_ISOLATION_STRICT;
        _resetOverrideStrictCache();
      });
      afterEach(() => {
        _resetOverrideStrictCache();
      });

      it('passes empty principals through to getApplicableConfigs', async () => {
        const deps = createDeps();
        const { getAppConfig } = createAppConfigService(deps);

        await getAppConfig();

        expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
      });

      it('scopes the override cache key to the ALS tenant when no tenantId param is given', async () => {
        const { tenantStorage } = jest.requireActual('@librechat/data-schemas');
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig({ role: 'USER' }),
        );

        const overrideKey = [...deps._cache._store.keys()].find((k: string) =>
          k.includes('_OVERRIDE_:'),
        );
        expect(overrideKey).toBe('app_config:_OVERRIDE_:tenant-a:USER');
        expect(overrideKey).not.toContain('__default__');
      });

      it('does not serve one tenant a cached config built for another tenant', async () => {
        const { tenantStorage, getTenantId } = jest.requireActual('@librechat/data-schemas');
        // Each tenant's DB overrides carry a marker derived from the active ALS tenant.
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockImplementation(async () => [
              { priority: 10, overrides: { whoami: getTenantId() }, isActive: true },
            ]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        const configA = (await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig({ role: 'USER' }),
        )) as TestConfig & { whoami?: string };
        const configB = (await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
          getAppConfig({ role: 'USER' }),
        )) as TestConfig & { whoami?: string };

        expect(configA.whoami).toBe('tenant-a');
        expect(configB.whoami).toBe('tenant-b');
        // A cache collision would short-circuit the second tenant's DB read.
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
      });
    });

    it('does not cache on buildPrincipals error — retries on next request', async () => {
      const deps = createDeps({
        getUserPrincipals: jest
          .fn()
          .mockRejectedValueOnce(new Error('transient'))
          .mockResolvedValue([{ principalType: 'role', principalId: 'USER' }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const first = await getAppConfig({ userId: 'uid1', role: 'USER' });
      expect(first).toEqual(deps._baseConfig);
      expect(deps.getApplicableConfigs).not.toHaveBeenCalled();

      await getAppConfig({ userId: 'uid1', role: 'USER' });
      expect(deps.getUserPrincipals).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });

    it('falls back to base config on getApplicableConfigs error', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockRejectedValue(new Error('DB down')),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'ADMIN' });

      expect(config).toEqual(deps._baseConfig);
    });

    it('calls getUserPrincipals when userId is provided', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER', userId: 'uid1' });

      expect(deps.getUserPrincipals).toHaveBeenCalledWith({
        userId: 'uid1',
        role: 'USER',
      });
    });

    it('reuses caller-resolved principals without querying them again', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);
      const resolvedPrincipals = [
        { principalType: 'role', principalId: 'USER' },
        { principalType: 'user', principalId: 'uid1' },
      ];

      await getAppConfig({ role: 'USER', userId: 'uid1', resolvedPrincipals });

      expect(deps.getUserPrincipals).not.toHaveBeenCalled();
      expect(deps.getApplicableConfigs).toHaveBeenCalledWith(resolvedPrincipals);
    });

    it('re-runs mutable principal config augmentation without rebuilding cached overrides', async () => {
      const augmentConfig = jest.fn(async ({ appConfig, principals }) => ({
        ...appConfig,
        principalCount: principals.length,
      }));
      const deps = createDeps({ augmentConfig });
      const { getAppConfig } = createAppConfigService(deps);

      const first = await getAppConfig({ role: 'USER', userId: 'uid1' });
      const second = await getAppConfig({ role: 'USER', userId: 'uid1' });

      expect(first).toEqual(expect.objectContaining({ principalCount: 2 }));
      expect(second).toEqual(expect.objectContaining({ principalCount: 2 }));
      expect(deps.getUserPrincipals).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
      expect(augmentConfig).toHaveBeenCalledTimes(2);
      expect(augmentConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          baseConfig: deps._baseConfig,
          principals: [
            { principalType: 'role', principalId: 'USER' },
            { principalType: 'user', principalId: 'uid1' },
          ],
          options: expect.objectContaining({ role: 'USER', userId: 'uid1' }),
        }),
      );
    });

    it('skips mutable runtime augmentation when the caller already loaded it', async () => {
      const augmentConfig = jest.fn(async ({ appConfig }) => appConfig);
      const deps = createDeps({ augmentConfig });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({
        role: 'USER',
        userId: 'uid1',
        skipRuntimeAugmentation: true,
      });

      expect(augmentConfig).not.toHaveBeenCalled();
    });

    it('preserves resolved principal restrictions when optional augmentation fails', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            priority: 10,
            overrides: { interface: { modelSelect: false } },
            isActive: true,
          },
        ]),
        augmentConfig: jest.fn().mockRejectedValue(new Error('authorization unavailable')),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'USER', userId: 'uid1' });

      expect(config).toEqual(
        expect.objectContaining({
          interfaceConfig: { modelSelect: false },
        }),
      );
    });

    it('propagates principal resolution failures for fail-closed callers', async () => {
      const error = new Error('principal authorization unavailable');
      const deps = createDeps({ getUserPrincipals: jest.fn().mockRejectedValue(error) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ role: 'USER', userId: 'uid1', failClosed: true })).rejects.toBe(
        error,
      );
    });

    it('propagates override resolution failures for fail-closed callers', async () => {
      const error = new Error('override authorization unavailable');
      const deps = createDeps({ getApplicableConfigs: jest.fn().mockRejectedValue(error) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ role: 'USER', userId: 'uid1', failClosed: true })).rejects.toBe(
        error,
      );
    });

    it('propagates principal augmentation failures for fail-closed callers', async () => {
      const error = new Error('environment authorization unavailable');
      const deps = createDeps({ augmentConfig: jest.fn().mockRejectedValue(error) });
      const { getAppConfig } = createAppConfigService(deps);

      await expect(getAppConfig({ role: 'USER', userId: 'uid1', failClosed: true })).rejects.toBe(
        error,
      );
    });

    it('passes local identity through to getUserPrincipals when provided', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER', userId: 'uid1', idOnTheSource: null });

      expect(deps.getUserPrincipals).toHaveBeenCalledWith({
        userId: 'uid1',
        role: 'USER',
        idOnTheSource: null,
      });
    });

    it('uses the same override cache entry when source identity changes for a user', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER', userId: 'uid1', idOnTheSource: null });
      await getAppConfig({ role: 'USER', userId: 'uid1', idOnTheSource: 'source-user-1' });

      expect(deps.getUserPrincipals).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
      expect([...deps._cache._store.keys()]).toEqual(
        expect.arrayContaining(['app_config:_OVERRIDE_:__default__:USER:uid1']),
      );
    });

    it('does not call getUserPrincipals when only role is provided', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN' });

      expect(deps.getUserPrincipals).not.toHaveBeenCalled();
    });
  });

  describe('clearAppConfigCache', () => {
    it('clears base config so it reloads on next call', async () => {
      const deps = createDeps();
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);

      await getAppConfig();
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);

      await clearAppConfigCache();
      await getAppConfig();
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearOverrideCache', () => {
    it('clears all override caches when no tenantId is provided', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);

      await clearOverrideCache();

      // After clearing, both tenants should re-query DB
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(4);
    });

    it('clears only specified tenant override caches', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { x: 1 }, isActive: true }]),
      });
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);

      await clearOverrideCache('tenant-a');

      // tenant-a should re-query, tenant-b should be cached
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-b' });
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(3);
    });

    it('does not clear base config', async () => {
      const deps = createDeps();
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      await getAppConfig();
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);

      await clearOverrideCache();

      await getAppConfig();
      // Base config should still be cached
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
    });

    it('does not throw when store.keys is unavailable (Redis fallback to TTL expiry)', async () => {
      const deps = createDeps();
      // Remove store.keys to simulate Redis-backed cache
      deps._cache.opts = {};
      const { clearOverrideCache } = createAppConfigService(deps);

      // Should not throw — logs warning and relies on TTL expiry
      await expect(clearOverrideCache()).resolves.toBeUndefined();
    });
  });
});

describe('getAppConfigOptionsFromUser', () => {
  it('maps resolved request users to app config principal options', () => {
    expect(
      getAppConfigOptionsFromUser({
        id: 'uid1',
        role: 'USER',
        tenantId: 'tenant-a',
        idOnTheSource: 'source-user-1',
      }),
    ).toEqual({
      role: 'USER',
      userId: 'uid1',
      idOnTheSource: 'source-user-1',
      tenantId: 'tenant-a',
    });
  });

  it('preserves omitted source identity for partial users so fallback lookup can run', () => {
    expect(getAppConfigOptionsFromUser({ id: 'uid1', role: 'USER' })).toEqual({
      role: 'USER',
      userId: 'uid1',
      idOnTheSource: undefined,
      tenantId: undefined,
    });
  });

  it('marks explicitly normalized local users with null idOnTheSource', () => {
    expect(getAppConfigOptionsFromUser({ id: 'uid1', role: 'USER', idOnTheSource: null })).toEqual({
      role: 'USER',
      userId: 'uid1',
      idOnTheSource: null,
      tenantId: undefined,
    });
  });

  it('omits source identity when no user id is available', () => {
    expect(getAppConfigOptionsFromUser({ role: 'USER', tenantId: 'tenant-a' })).toEqual({
      role: 'USER',
      userId: undefined,
      idOnTheSource: undefined,
      tenantId: 'tenant-a',
    });
  });
});
