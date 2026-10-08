import { getMaxSubagents, setMaxSubagents } from 'librechat-data-provider';
import { AppService, getTenantId, tenantStorage, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import {
  createAppConfigService,
  createMessageBudgetReader,
  _resetOverrideStrictCache,
  getAppConfigOptionsFromUser,
} from './service';
import { getProviderConfig } from '~/endpoints/config/providers';

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
      expect(deps.loadBaseConfig).toHaveBeenCalledWith('startup');
      expect(config).toEqual(deps._baseConfig);
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

    it('serves tenant-scoped YAML custom endpoints only to their tenant', async () => {
      const custom = [
        { name: 'Global', apiKey: 'global-key', baseURL: 'https://global.example' },
        {
          name: 'ClickHouse',
          tenantId: 'dwh-org',
          apiKey: 'dwh-key',
          baseURL: 'https://dwh.example',
        },
      ];
      const modelSpecs = {
        list: [
          { name: 'global-spec', preset: { endpoint: 'Global' } },
          { name: 'dwh-spec', softDefault: true, preset: { endpoint: 'ClickHouse' } },
        ],
        addedEndpoints: ['agents', 'ClickHouse'],
      };
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue({
          endpoints: { custom },
          modelSpecs,
          config: { endpoints: { custom }, modelSpecs },
        }),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const base = await getAppConfig({ baseOnly: true });
      const tenantBase = await getAppConfig({ baseOnly: true, tenantId: 'dwh-org' });
      const dwh = await getAppConfig({ role: 'USER', tenantId: 'dwh-org' });
      const other = await getAppConfig({ role: 'USER', tenantId: 'other-org' });
      const staleUserTenant = await tenantStorage.run({ tenantId: 'other-org' }, () =>
        getAppConfig({ role: 'USER', tenantId: 'dwh-org' }),
      );

      expect(base.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual(['Global']);
      expect(tenantBase.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual([
        'Global',
        'ClickHouse',
      ]);
      expect(dwh.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual([
        'Global',
        'ClickHouse',
      ]);
      expect(other.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual(['Global']);
      expect(other.config.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual(['Global']);
      expect(base.modelSpecs?.list?.map((spec) => spec.name)).toEqual(['global-spec']);
      expect(tenantBase.modelSpecs?.list?.map((spec) => spec.name)).toEqual([
        'global-spec',
        'dwh-spec',
      ]);
      expect(other.modelSpecs?.addedEndpoints).toEqual(['agents']);
      expect(other.config.modelSpecs?.list?.map((spec) => spec.name)).toEqual(['global-spec']);
      expect(staleUserTenant.modelSpecs?.list?.map((spec) => spec.name)).toEqual(['global-spec']);
      expect(staleUserTenant.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual([
        'Global',
      ]);
      expect(
        getProviderConfig({ provider: 'ClickHouse', appConfig: dwh }).customEndpointConfig?.baseURL,
      ).toBe('https://dwh.example');
      expect(() => getProviderConfig({ provider: 'ClickHouse', appConfig: other })).toThrow(
        'Provider ClickHouse not supported',
      );
      expect(custom).toHaveLength(2);
    });

    it.each([false, true])(
      'prefers tenant providers over same-named global providers (tenant first: %s)',
      async (tenantFirst) => {
        const global = {
          name: 'Claude',
          apiKey: 'global-key',
          baseURL: 'https://global.example',
          models: { default: ['global-model'], fetch: false },
        };
        const tenants = ['tenant-a', 'tenant-b'].map((tenantId) => ({
          ...global,
          name: 'Claude',
          tenantId,
          apiKey: 'tenant-key',
          baseURL: 'https://tenant.example',
          models: { default: ['tenant-model'], fetch: false },
        }));
        const custom = tenantFirst ? [...tenants, global] : [global, ...tenants];
        const modelSpecs = {
          list: [{ name: 'agent-spec', preset: { endpoint: 'Claude' } }],
          addedEndpoints: ['agents'],
        };
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue({
            endpoints: { custom },
            modelSpecs,
            config: { endpoints: { custom }, modelSpecs },
          }),
        });
        const { getAppConfig } = createAppConfigService(deps);

        for (const tenantId of ['tenant-a', 'tenant-c', 'tenant-b', 'tenant-a']) {
          const config = await getAppConfig({ role: 'USER', tenantId });
          const expected = tenants.find((endpoint) => endpoint.tenantId === tenantId) ?? global;
          expect(config.endpoints?.custom).toEqual([expected]);
          expect(config.config.endpoints?.custom).toEqual([expected]);
          expect(config.modelSpecs).toEqual(modelSpecs);
          const provider = getProviderConfig({ provider: 'Claude', appConfig: config });
          expect(provider.customEndpointConfig?.apiKey).toBe(expected.apiKey);
          expect(provider.customEndpointConfig?.models).toEqual(expected.models);
        }

        const base = await getAppConfig({ baseOnly: true });
        expect(base.endpoints?.custom).toEqual([global]);
        expect(custom).toHaveLength(3);
        expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
      },
    );

    it('removes a prioritized spec when its only endpoint belongs to another tenant', async () => {
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue({
          endpoints: { custom: [{ name: 'ClickHouse', tenantId: 'dwh-org' }] },
          modelSpecs: {
            prioritize: true,
            list: [{ name: 'dwh-spec', preset: { endpoint: 'ClickHouse' } }],
          },
        }),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'USER', tenantId: 'other-org' });

      expect(config.endpoints?.custom).toEqual([]);
      expect(config.modelSpecs).toBeUndefined();
    });

    describe('tenant isolation invariants', () => {
      async function tenantBase(interfaceConfig?: AppConfig['interfaceConfig']) {
        return AppService({
          config: {
            interface: interfaceConfig,
            endpoints: {
              custom: [
                {
                  name: 'Private Gateway',
                  tenantId: 'tenant-a',
                  apiKey: 'private-gateway-key',
                  baseURL: 'https://private.example',
                  models: { default: ['private-model'] },
                },
              ],
            },
            modelSpecs: {
              enforce: true,
              prioritize: true,
              list: [
                { name: 'private-spec', label: 'Private', preset: { endpoint: 'Private Gateway' } },
              ],
            },
          },
        });
      }

      it('restores no-spec interface defaults without mutating the shared YAML base', async () => {
        const base = await tenantBase();
        const deps = createDeps({ loadBaseConfig: jest.fn().mockResolvedValue(base) });
        const { getAppConfig } = createAppConfigService(deps);
        const [owner, other, anonymous] = await Promise.all([
          getAppConfig({ baseOnly: true, tenantId: 'tenant-a' }),
          getAppConfig({ baseOnly: true, tenantId: 'tenant-b' }),
          getAppConfig({ baseOnly: true }),
        ]);
        expect(owner.modelSpecs?.list).toHaveLength(1);
        expect(owner.interfaceConfig).toMatchObject({
          modelSelect: false,
          parameters: false,
          presets: false,
        });
        for (const config of [other, anonymous]) {
          expect(config.modelSpecs).toBeUndefined();
          expect(config.config.modelSpecs).toBeUndefined();
          expect(config.interfaceConfig).toMatchObject({
            modelSelect: true,
            parameters: true,
            presets: true,
          });
          expect(config.endpoints?.custom).toEqual([]);
        }
        expect(base.modelSpecs?.list).toHaveLength(1);
        expect(base.config.endpoints?.custom).toHaveLength(1);
        expect(base.interfaceConfig?.modelSelect).toBe(false);
      });

      it.each(['yaml', 'override'])(
        'preserves explicit %s interface restrictions after dropping the last spec',
        async (source) => {
          const explicit = {
            modelSelect: false,
            parameters: false,
            presets: false,
            customWelcome: 'Welcome',
          };
          const base = await tenantBase(source === 'yaml' ? explicit : undefined);
          const deps = createDeps({
            loadBaseConfig: jest.fn().mockResolvedValue(base),
            getApplicableConfigs: jest
              .fn()
              .mockResolvedValue(
                source === 'override'
                  ? [{ priority: 10, overrides: { interface: explicit }, isActive: true }]
                  : [],
              ),
          });
          const { getAppConfig } = createAppConfigService(deps);
          for (let i = 0; i < 2; i++) {
            const config = await getAppConfig({ role: 'USER', tenantId: 'tenant-b' });
            expect(config.modelSpecs).toBeUndefined();
            expect(config.interfaceConfig).toMatchObject(explicit);
          }
          expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
        },
      );

      it('recomputes model selection when only the added custom endpoint is hidden', async () => {
        const base = await tenantBase();
        base.modelSpecs = {
          list: [{ name: 'public-spec', label: 'Public', preset: { endpoint: 'openAI' } }],
          addedEndpoints: ['Private Gateway'],
        };
        base.config.modelSpecs = base.modelSpecs;
        base.interfaceConfig = { modelSelect: true, parameters: false, presets: false };
        const deps = createDeps({ loadBaseConfig: jest.fn().mockResolvedValue(base) });
        const { getAppConfig } = createAppConfigService(deps);
        const other = await getAppConfig({ tenantId: 'tenant-b' });
        expect(other.modelSpecs?.list).toHaveLength(1);
        expect(other.modelSpecs?.addedEndpoints).toEqual([]);
        expect(other.interfaceConfig).toMatchObject({
          modelSelect: false,
          parameters: false,
          presets: false,
        });
      });

      it('uses the ambient tenant for override reads, cache writes, hits, and invalidation despite stale user IDs', async () => {
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockImplementation(async () => [
              { priority: 10, overrides: { x: getTenantId() }, isActive: true },
            ]),
        });
        const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);
        const read = (tenant: string, stale: string) =>
          tenantStorage.run({ tenantId: tenant }, () =>
            getAppConfig({ role: 'USER', tenantId: stale }),
          );
        expect(((await read('tenant-a', 'tenant-b')) as TestConfig).x).toBe('tenant-a');
        expect(((await read('tenant-b', 'tenant-a')) as TestConfig).x).toBe('tenant-b');
        expect(((await read('tenant-a', 'tenant-b')) as TestConfig).x).toBe('tenant-a');
        expect(((await read('tenant-b', 'tenant-a')) as TestConfig).x).toBe('tenant-b');
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
        await clearOverrideCache('tenant-a');
        await read('tenant-b', 'tenant-a');
        await read('tenant-a', 'tenant-b');
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(3);
      });

      it('separates a real __default__ tenant from requests without a tenant, including invalidation', async () => {
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockImplementation(async () => [
              { priority: 10, overrides: { x: getTenantId() ?? 'global' }, isActive: true },
            ]),
        });
        const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);
        const global = () => getAppConfig({ role: 'USER' });
        const tenant = () => getAppConfig({ role: 'USER', tenantId: '__default__' });
        expect(((await global()) as TestConfig).x).toBe('global');
        expect(((await tenant()) as TestConfig).x).toBe('__default__');
        expect(((await global()) as TestConfig).x).toBe('global');
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
        await clearOverrideCache('__default__');
        await global();
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
        expect(((await tenant()) as TestConfig).x).toBe('__default__');
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(3);
      });

      it('ignores override cache entries written by heads with stale tenant-key selection', async () => {
        const deps = createDeps();
        await deps._cache.set('_OVERRIDE_:tenant-a:USER', { x: 'tenant-b' });
        const { getAppConfig } = createAppConfigService(deps);
        const config = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          getAppConfig({ role: 'USER' }),
        );
        expect((config as TestConfig).x).toBeUndefined();
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
      });

      it.each([undefined, SYSTEM_TENANT_ID])(
        'applies an explicit tenant to database and runtime lookups from %s context',
        async (ambient) => {
          const observed: Array<string | undefined> = [];
          const deps = createDeps({
            getApplicableConfigs: jest.fn().mockImplementation(async () => {
              observed.push(getTenantId());
              return [];
            }),
            augmentConfig: jest.fn(async ({ appConfig, options }) => {
              expect(options.tenantId).toBe(getTenantId());
              observed.push(getTenantId());
              return appConfig;
            }),
          });
          const { getAppConfig } = createAppConfigService(deps);
          await tenantStorage.run({ tenantId: ambient, requestId: 'request-1' }, async () => {
            await getAppConfig({ role: 'USER', tenantId: 'tenant-a' });
            await getAppConfig({ role: 'USER', tenantId: 'tenant-b' });
            expect(getTenantId()).toBe(ambient);
            expect(tenantStorage.getStore()?.requestId).toBe('request-1');
          });
          expect(observed).toEqual(['tenant-a', 'tenant-a', 'tenant-b', 'tenant-b']);
        },
      );

      it('never treats the system sentinel as a tenant-owned endpoint selector', async () => {
        const base = await tenantBase();
        const deps = createDeps({ loadBaseConfig: jest.fn().mockResolvedValue(base) });
        const { getAppConfig } = createAppConfigService(deps);
        const config = await tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, () =>
          getAppConfig({ baseOnly: true, tenantId: SYSTEM_TENANT_ID }),
        );
        expect(config.endpoints?.custom).toEqual([]);
        expect(config.modelSpecs).toBeUndefined();
      });

      it.each(['principals', 'overrides', 'augmentation'])(
        'keeps fallback configuration scoped on %s failure',
        async (stage) => {
          const base = await tenantBase();
          const deps = createDeps({ loadBaseConfig: jest.fn().mockResolvedValue(base) });
          if (stage === 'principals')
            deps.getUserPrincipals.mockRejectedValue(new Error('unavailable'));
          if (stage === 'overrides')
            deps.getApplicableConfigs.mockRejectedValue(new Error('unavailable'));
          const { getAppConfig } = createAppConfigService({
            ...deps,
            ...(stage === 'augmentation' && {
              augmentConfig: jest.fn().mockRejectedValue(new Error('unavailable')),
            }),
          });
          const config = await getAppConfig({ userId: 'uid1', role: 'USER', tenantId: 'tenant-b' });
          expect(config.endpoints?.custom).toEqual([]);
          expect(config.config.endpoints?.custom).toEqual([]);
          expect(config.modelSpecs).toBeUndefined();
          expect(config.interfaceConfig).toMatchObject({
            modelSelect: true,
            parameters: true,
            presets: true,
          });
        },
      );

      it('does not let an override reassign a hidden YAML endpoint or inherit its credentials', async () => {
        const base = await tenantBase();
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(base),
          getApplicableConfigs: jest.fn().mockResolvedValue([
            {
              priority: 10,
              isActive: true,
              overrides: {
                endpoints: { custom: [{ name: 'Private Gateway', tenantId: 'tenant-b' }] },
                modelSpecs: {
                  list: [
                    {
                      name: 'injected',
                      label: 'Injected',
                      preset: { endpoint: 'Private Gateway' },
                    },
                  ],
                },
              },
            },
          ]),
        });
        const { getAppConfig } = createAppConfigService(deps);
        for (let i = 0; i < 2; i++) {
          const config = await getAppConfig({ role: 'USER', tenantId: 'tenant-b' });
          expect(config.endpoints?.custom).toEqual([]);
          expect(config.modelSpecs).toBeUndefined();
          expect(JSON.stringify(config)).not.toContain('private-gateway-key');
        }
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
      });

      it('keeps tenant-owned YAML fields available to partial admin overrides', async () => {
        const base = await tenantBase();
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(base),
          getApplicableConfigs: jest.fn().mockResolvedValue([
            {
              priority: 10,
              isActive: true,
              overrides: {
                endpoints: {
                  custom: [{ name: 'Private Gateway', baseURL: 'https://override.example' }],
                },
              },
            },
          ]),
        });
        const { getAppConfig } = createAppConfigService(deps);
        const owner = await getAppConfig({ role: 'USER', tenantId: 'tenant-a' });
        expect(owner.endpoints?.custom?.[0]).toMatchObject({
          tenantId: 'tenant-a',
          apiKey: 'private-gateway-key',
          baseURL: 'https://override.example',
        });
        expect(owner.modelSpecs?.list).toHaveLength(1);
        const yaml = await getAppConfig({ tenantId: 'tenant-a', baseOnly: true });
        expect(yaml.config.endpoints?.custom?.[0].baseURL).toBe('https://private.example');
      });

      it('revokes a cached endpoint when a successful YAML reload changes its tenant', async () => {
        const original = await tenantBase();
        const updated = await tenantBase();
        for (const endpoint of updated.endpoints?.custom ?? []) endpoint.tenantId = 'tenant-b';
        for (const endpoint of updated.config.endpoints?.custom ?? [])
          endpoint.tenantId = 'tenant-b';
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValueOnce(original).mockResolvedValue(updated),
        });
        const { getAppConfig } = createAppConfigService(deps);
        const owner = await getAppConfig({ role: 'USER', tenantId: 'tenant-a' });
        expect(owner.endpoints?.custom).toHaveLength(1);
        await getAppConfig({ tenantId: 'tenant-b', baseOnly: true, refresh: true });
        const revoked = await getAppConfig({ role: 'USER', tenantId: 'tenant-a' });
        expect(revoked.endpoints?.custom).toEqual([]);
        expect(revoked.modelSpecs).toBeUndefined();
        expect(JSON.stringify(revoked)).not.toContain('private-gateway-key');
        expect(revoked.interfaceConfig).toMatchObject({
          modelSelect: true,
          parameters: true,
          presets: true,
        });
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
      });

      it('passes only scoped inputs to augmentation and blocks hidden endpoint resurrection', async () => {
        const base = await tenantBase();
        const augmentConfig = jest.fn(async ({ appConfig, baseConfig, options }) => {
          expect(baseConfig.endpoints?.custom).toEqual([]);
          expect(appConfig.config.endpoints?.custom).toEqual([]);
          expect(options.tenantId).toBe('tenant-b');
          return {
            ...appConfig,
            endpoints: { custom: [{ ...base.endpoints?.custom?.[0], tenantId: 'tenant-b' }] },
          };
        });
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(base),
          augmentConfig,
        });
        const { getAppConfig } = createAppConfigService(deps);
        const config = await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
          getAppConfig({ role: 'USER', tenantId: 'tenant-a' }),
        );
        expect(config.endpoints?.custom).toEqual([]);
        expect(augmentConfig).toHaveBeenCalledTimes(1);
      });

      it('preserves an unscoped endpoint and its specs when a hidden endpoint shares its normalized name', async () => {
        const base = await tenantBase();
        const global = {
          ...base.endpoints?.custom?.[0],
          tenantId: undefined,
          apiKey: 'global-key',
        };
        base.endpoints?.custom?.push(global);
        if (base.config.endpoints?.custom !== base.endpoints?.custom) {
          base.config.endpoints?.custom?.push(global);
        }
        const deps = createDeps({ loadBaseConfig: jest.fn().mockResolvedValue(base) });
        const { getAppConfig } = createAppConfigService(deps);
        const config = await getAppConfig({ tenantId: 'tenant-b' });
        expect(config.endpoints?.custom).toEqual([global]);
        expect(config.modelSpecs?.list).toHaveLength(1);
        expect(
          getProviderConfig({ provider: 'Private Gateway', appConfig: config }).customEndpointConfig
            ?.apiKey,
        ).toBe('global-key');
      });

      it('keeps source-only hidden specs out when the effective custom endpoint array is empty', async () => {
        const base = await tenantBase();
        base.endpoints = { custom: [] };
        const deps = createDeps({ loadBaseConfig: jest.fn().mockResolvedValue(base) });
        const { getAppConfig } = createAppConfigService(deps);
        const config = await getAppConfig({ baseOnly: true, tenantId: 'tenant-b' });
        expect(config.config.endpoints?.custom).toEqual([]);
        expect(config.modelSpecs).toBeUndefined();
      });
    });

    it('reloads base config when refresh is true', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig();
      await getAppConfig({ refresh: true });

      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
      expect(deps.loadBaseConfig).toHaveBeenLastCalledWith('reload');
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
        expect(deps.loadBaseConfig).toHaveBeenLastCalledWith('reload');
      },
    );

    it.each(['tools', 'cache'])(
      'restores the subagent cap if %s publication fails',
      async (stage) => {
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue({
            config: { endpoints: { agents: { maxSubagents: 3 } } },
            availableTools: { previous: {} },
          }),
        });
        const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);
        try {
          await getAppConfig({ baseOnly: true });
          setMaxSubagents(3);
          await clearAppConfigCache();
          deps.loadBaseConfig.mockImplementationOnce(async () => {
            setMaxSubagents(20);
            return {
              config: { endpoints: { agents: { maxSubagents: 20 } } },
              availableTools: { new: {} },
            };
          });
          if (stage === 'tools') {
            deps.setCachedTools.mockRejectedValueOnce(new Error('tools unavailable'));
          } else {
            deps._cache.set.mockRejectedValueOnce(new Error('cache unavailable'));
          }

          const kept = await getAppConfig({ baseOnly: true });
          expect(kept.config?.endpoints?.agents?.maxSubagents).toBe(3);
          expect(getMaxSubagents()).toBe(3);
        } finally {
          setMaxSubagents(undefined);
        }
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
      await Promise.resolve();
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
      expect(deps.loadBaseConfig).toHaveBeenCalledWith('startup');
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

    it('leaves unknown colors out of a theme a DB override supplies', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            priority: 10,
            isActive: true,
            overrides: {
              interface: {
                theme: {
                  version: 1,
                  name: 'override',
                  modes: {
                    light: {
                      colors: { 'rgb-surface-primary': '1 2 3', 'surface-future': '4 5 6' },
                    },
                  },
                },
              },
            },
          },
        ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'USER' });

      expect(config.interfaceConfig?.theme).toEqual({
        version: 1,
        name: 'override',
        modes: { light: { colors: { 'rgb-surface-primary': '1 2 3' } } },
      });
      expect(config.interfaceConfig?.modelSelect).toBe(true);
    });

    it.each([true, false])(
      'preserves tenant isolation through a theme override (valid: %s), including cache hits',
      async (valid) => {
        const custom = [
          { name: 'Global', baseURL: 'https://global.example' },
          { name: 'Private', tenantId: 'owner-tenant', baseURL: 'https://private.example' },
        ];
        const base = {
          interfaceConfig: { theme: 'clickhouse' },
          endpoints: { custom },
          config: { endpoints: { custom } },
        };
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(base),
          getApplicableConfigs: jest.fn().mockResolvedValue([
            {
              priority: 10,
              isActive: true,
              overrides: {
                interface: {
                  theme: {
                    version: 1,
                    name: 'override',
                    modes: {
                      light: {
                        colors: {
                          'rgb-surface-primary': valid ? '1 2 3' : '300 16 32',
                          'surface-future': '4 5 6',
                        },
                      },
                    },
                  },
                },
              },
            },
          ]),
        });
        const { getAppConfig } = createAppConfigService(deps);
        for (const tenantId of ['other-tenant', 'owner-tenant', 'other-tenant']) {
          const config = await getAppConfig({ role: 'USER', tenantId });
          const names = tenantId === 'owner-tenant' ? ['Global', 'Private'] : ['Global'];
          expect(config.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual(names);
          expect(config.config.endpoints?.custom?.map((endpoint) => endpoint.name)).toEqual(names);
          expect(config.interfaceConfig?.theme).toEqual(
            valid
              ? {
                  version: 1,
                  name: 'override',
                  modes: { light: { colors: { 'rgb-surface-primary': '1 2 3' } } },
                }
              : 'clickhouse',
          );
        }
        expect(custom).toHaveLength(2);
        expect(base.interfaceConfig.theme).toBe('clickhouse');
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
      },
    );

    it('keeps the base theme when a DB override supplies an invalid one', async () => {
      const deps = createDeps({
        loadBaseConfig: jest
          .fn()
          .mockResolvedValue({ interfaceConfig: { modelSelect: true, theme: 'clickhouse' } }),
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            priority: 10,
            isActive: true,
            overrides: {
              interface: {
                theme: {
                  version: 1,
                  name: 'override',
                  modes: { dark: { colors: { 'rgb-surface-primary': '300 16 32' } } },
                },
              },
            },
          },
        ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'USER' });

      expect(config.interfaceConfig?.theme).toBe('clickhouse');
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
      expect(overrideKey).toMatch(
        /^app_config:_OVERRIDE_:__default__:global:uid1:tenant-v1:[a-f0-9]{64}$/,
      );
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
        expect(overrideKey).toMatch(
          /^app_config:_OVERRIDE_:tenant-a:tenant:USER:tenant-v1:[a-f0-9]{64}$/,
        );
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
        expect.arrayContaining([
          expect.stringMatching(
            /^app_config:_OVERRIDE_:__default__:global:USER:uid1:tenant-v1:[a-f0-9]{64}$/,
          ),
        ]),
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

describe('message App budget reader composition', () => {
  it('fails closed before the host supplies the base config reader', async () => {
    const reader = createMessageBudgetReader();
    await expect(reader.getBudget()).rejects.toThrow('not been initialized');
  });

  it('reads deployment-only values lazily and observes reconfiguration without caching', async () => {
    const reader = createMessageBudgetReader();
    const getConfig = jest
      .fn()
      .mockResolvedValue({ mcpAppSandbox: { maxPersistedMessageBytes: 2 * 1024 * 1024 } });
    reader.initialize(getConfig);
    expect(getConfig).not.toHaveBeenCalled();
    expect(await reader.getBudget()).toBe(2 * 1024 * 1024);
    expect(getConfig).toHaveBeenLastCalledWith({ baseOnly: true });
    getConfig.mockResolvedValue({ mcpAppSandbox: { maxPersistedMessageBytes: 4 * 1024 * 1024 } });
    expect(await reader.getBudget()).toBe(4 * 1024 * 1024);
    getConfig.mockRejectedValue(new Error('configuration unavailable'));
    await expect(reader.getBudget()).rejects.toThrow('configuration unavailable');
  });

  it('keeps independent hosts isolated and leaves an omitted limit to the storage default', async () => {
    const a = createMessageBudgetReader();
    const b = createMessageBudgetReader();
    a.initialize(jest.fn().mockResolvedValue({}));
    expect(await a.getBudget()).toBeUndefined();
    await expect(b.getBudget()).rejects.toThrow('not been initialized');
  });
});
