import { PrincipalType, getMaxSubagents, setMaxSubagents } from 'librechat-data-provider';
import {
  logger,
  AppService,
  getTenantId,
  tenantStorage,
  SYSTEM_TENANT_ID,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import {
  createAppConfigService,
  createMessageBudgetReader,
  DEFAULT_OVERRIDE_CACHE_TTL,
  _resetOverrideStrictCache,
  getAppConfigOptionsFromUser,
} from './service';
import { loadCustomEndpointsConfig } from '~/endpoints/custom/config';
import { getProviderConfig } from '~/endpoints/config/providers';
import { expandCustomEndpoint } from './params';
import { ConfigReloadError } from './loader';

/** Extends AppConfig with mock fields used by merge behavior tests. */
/** `version` is a plain string section, so a test can mark which override layer it read. */
interface TestConfig extends AppConfig {
  version?: string;
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

    it('keeps the other added endpoints when another tenant owns every spec', async () => {
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue({
          endpoints: { custom: [{ name: 'ClickHouse', tenantId: 'dwh-org' }] },
          modelSpecs: {
            list: [{ name: 'dwh-spec', preset: { endpoint: 'ClickHouse' } }],
            addedEndpoints: ['agents', 'ClickHouse'],
          },
        }),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'USER', tenantId: 'other-org' });

      expect(config.modelSpecs).toEqual({ list: [], addedEndpoints: ['agents'] });
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
              { priority: 10, overrides: { version: getTenantId() }, isActive: true },
            ]),
        });
        const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);
        const read = (tenant: string, stale: string) =>
          tenantStorage.run({ tenantId: tenant }, () =>
            getAppConfig({ role: 'USER', tenantId: stale }),
          );
        expect(((await read('tenant-a', 'tenant-b')) as TestConfig).version).toBe('tenant-a');
        expect(((await read('tenant-b', 'tenant-a')) as TestConfig).version).toBe('tenant-b');
        expect(((await read('tenant-a', 'tenant-b')) as TestConfig).version).toBe('tenant-a');
        expect(((await read('tenant-b', 'tenant-a')) as TestConfig).version).toBe('tenant-b');
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
              { priority: 10, overrides: { version: getTenantId() ?? 'global' }, isActive: true },
            ]),
        });
        const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);
        const global = () => getAppConfig({ role: 'USER' });
        const tenant = () => getAppConfig({ role: 'USER', tenantId: '__default__' });
        expect(((await global()) as TestConfig).version).toBe('global');
        expect(((await tenant()) as TestConfig).version).toBe('__default__');
        expect(((await global()) as TestConfig).version).toBe('global');
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
        await clearOverrideCache('__default__');
        await global();
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
        expect(((await tenant()) as TestConfig).version).toBe('__default__');
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(3);
      });

      it('ignores override cache entries written by heads with stale tenant-key selection', async () => {
        const deps = createDeps();
        await deps._cache.set('_OVERRIDE_:tenant-a:USER', { version: 'tenant-b' });
        const { getAppConfig } = createAppConfigService(deps);
        const config = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          getAppConfig({ role: 'USER' }),
        );
        expect((config as TestConfig).version).toBeUndefined();
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
                  custom: [{ name: 'Private Gateway', models: { default: ['override-model'] } }],
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
          baseURL: 'https://private.example',
          models: { default: ['override-model'] },
        });
        expect(owner.modelSpecs?.list).toHaveLength(1);
        const yaml = await getAppConfig({ tenantId: 'tenant-a', baseOnly: true });
        expect(yaml.config.endpoints?.custom?.[0].models?.default).toEqual(['private-model']);
      });

      it('drops the YAML key when a partial admin override points the endpoint elsewhere', async () => {
        const base = await tenantBase();
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(base),
          getApplicableConfigs: jest.fn().mockResolvedValue([
            {
              principalType: PrincipalType.ROLE,
              principalId: 'USER',
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
        const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
        const { getAppConfig } = createAppConfigService(deps);
        const owner = await getAppConfig({ role: 'USER', tenantId: 'tenant-a' });
        expect(owner.endpoints?.custom?.[0]).toMatchObject({
          tenantId: 'tenant-a',
          apiKey: '',
          baseURL: 'https://override.example',
        });
        expect(JSON.stringify(owner.endpoints)).not.toContain('private-gateway-key');
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Dropping secret "endpoints.custom["Private Gateway"].apiKey"'),
        );
        warn.mockRestore();
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

    describe('endpoint names the runtime folds together', () => {
      function ollamaBase() {
        return AppService({
          config: {
            interface: { modelSelect: true },
            endpoints: {
              custom: [
                {
                  name: 'Ollama',
                  apiKey: 'ollama',
                  baseURL: 'http://yaml-host:11434/v1',
                  models: { default: ['llama3'] },
                  modelDisplayLabel: 'Ollama (YAML)',
                },
              ],
              agents: { allowedProviders: ['Ollama', 'openAI'] },
            },
            modelSpecs: {
              list: [{ name: 'local', label: 'Local', preset: { endpoint: 'Ollama' } }],
              addedEndpoints: ['Ollama', 'agents', 'ollama'],
            },
          },
        });
      }

      it('serves YAML endpoint references under their served names', async () => {
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(await ollamaBase()),
        });
        const { getAppConfig } = createAppConfigService(deps);

        for (const config of [
          await getAppConfig({ baseOnly: true }),
          await getAppConfig({ role: 'USER' }),
        ]) {
          expect(config.modelSpecs?.addedEndpoints).toEqual(['ollama', 'agents']);
          expect(config.modelSpecs?.list?.[0]?.preset?.endpoint).toBe('ollama');
          expect(config.endpoints?.agents?.allowedProviders).toEqual(['ollama', 'openAI']);
        }
      });

      it('merges an override `ollama` into the YAML `Ollama` and serves it as one endpoint', async () => {
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(await ollamaBase()),
          getApplicableConfigs: jest.fn().mockResolvedValue([
            {
              priority: 10,
              isActive: true,
              overrides: {
                endpoints: {
                  custom: [
                    {
                      name: 'ollama',
                      apiKey: 'ollama',
                      baseURL: 'http://override:11434/v1',
                      modelDisplayLabel: 'Ollama (override)',
                    },
                  ],
                  agents: { allowedProviders: ['Ollama'] },
                },
                modelSpecs: {
                  list: [{ name: 'override', label: 'Override', preset: { endpoint: 'OLLAMA' } }],
                  addedEndpoints: ['Ollama'],
                },
              },
            },
          ]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        const config = await getAppConfig({ role: 'USER' });

        expect(config.endpoints?.custom).toHaveLength(1);
        expect(config.endpoints?.custom?.[0]?.name).toBe('Ollama');
        const served = loadCustomEndpointsConfig(config.endpoints?.custom);
        expect(Object.keys(served ?? {})).toEqual(['ollama']);
        expect(served?.ollama?.modelDisplayLabel).toBe('Ollama (override)');
        const provider = getProviderConfig({ provider: 'ollama', appConfig: config });
        expect(provider.customEndpointConfig?.baseURL).toBe('http://override:11434/v1');
        expect(provider.customEndpointConfig?.apiKey).toBe('ollama');
        expect(config.endpoints?.agents?.allowedProviders).toEqual(['ollama']);
        expect(config.modelSpecs?.list?.[0]?.preset?.endpoint).toBe('ollama');
        expect(config.modelSpecs?.addedEndpoints).toEqual(['ollama']);
      });

      it('drops the YAML `Ollama` key an override `ollama` points elsewhere without it', async () => {
        const deps = createDeps({
          loadBaseConfig: jest.fn().mockResolvedValue(await ollamaBase()),
          getApplicableConfigs: jest.fn().mockResolvedValue([
            {
              principalType: PrincipalType.ROLE,
              principalId: 'USER',
              priority: 10,
              isActive: true,
              overrides: {
                endpoints: { custom: [{ name: 'ollama', baseURL: 'http://override:11434/v1' }] },
              },
            },
          ]),
        });
        const warn = jest.spyOn(logger, 'warn').mockReturnValue(logger);
        const { getAppConfig } = createAppConfigService(deps);

        const config = await getAppConfig({ role: 'USER' });

        expect(config.endpoints?.custom).toEqual([
          expect.objectContaining({
            name: 'Ollama',
            apiKey: '',
            baseURL: 'http://override:11434/v1',
          }),
        ]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Dropping secret "endpoints.custom["Ollama"].apiKey"'),
        );
        warn.mockRestore();
      });
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

    /**
     * `paths` drives where uploads are written and deleted, and `config` is the raw
     * librechat.yaml that operator-only readers trust; neither is a `configSchema` section,
     * so an override stored under one (or a tombstone on one) must not reach them.
     */
    it('ignores stored overrides and tombstones on runtime state outside configSchema', async () => {
      const baseConfig = {
        paths: { uploads: '/srv/uploads', imageOutput: '/srv/images' },
        config: { permissions: { leaseTtlMs: 60_000 } },
        interfaceConfig: { modelSelect: true, prompts: true },
      };
      const deps = createDeps({
        loadBaseConfig: jest.fn().mockResolvedValue(baseConfig),
        getApplicableConfigs: jest.fn().mockResolvedValue([
          {
            principalType: 'role',
            principalId: 'USER',
            priority: 10,
            isActive: true,
            overrides: {
              paths: { uploads: '/tmp/attacker' },
              config: { permissions: { leaseTtlMs: 1 } },
              interfaceConfig: { prompts: false },
              interface: { modelSelect: false },
            },
            tombstones: ['paths.imageOutput', 'config'],
          },
        ]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const config = await getAppConfig({ role: 'USER' });

      expect(config.paths).toEqual(baseConfig.paths);
      expect(config.config).toEqual(baseConfig.config);
      expect(config.interfaceConfig).toEqual({ modelSelect: false, prompts: true });
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

    it('merges in precedence order, so cached and uncached reads agree on tied priorities', async () => {
      const layer = (
        principalType: string,
        principalId: string,
        priority: number,
        _id: string,
        customWelcome: string,
      ) => ({
        _id,
        principalType,
        principalId,
        priority,
        overrides: { interface: { customWelcome } },
        isActive: true,
      });
      const layers = [
        layer('role', '__base__', 90, '0a', 'base'),
        layer('group', 'g1', 20, '0c', 'g1'),
        layer('group', 'g2', 20, '0b', 'g2'),
        layer('role', 'USER', 20, '0d', 'role'),
      ];
      let call = 0;
      /** The store returns the same documents in a different order on every read. */
      const getApplicableConfigs = jest.fn(async () => {
        call += 1;
        return call % 2 === 0 ? [...layers].reverse() : [...layers];
      });
      const deps = createDeps({ getApplicableConfigs });
      const { getAppConfig } = createAppConfigService(deps);

      const cached = await getAppConfig({ role: 'USER', userId: 'uid1' });
      const uncached = await getAppConfig({ role: 'USER', userId: 'uid1', refresh: true });

      expect(getApplicableConfigs).toHaveBeenCalledTimes(2);
      expect(cached.interfaceConfig?.customWelcome).toBe('g1');
      expect(uncached).toEqual(cached);

      layers.push(layer('user', 'uid1', 20, '00', 'user'));
      const userWins = await getAppConfig({ role: 'USER', userId: 'uid1', refresh: true });
      expect(userWins.interfaceConfig?.customWelcome).toBe('user');
    });

    it('caches merged result with TTL', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { version: '1' }, isActive: true }]),
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
            { priority: 100, overrides: { version: 'user-specific' }, isActive: true },
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
          .mockResolvedValue([{ priority: 100, overrides: { version: '1' }, isActive: true }]),
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
          .mockResolvedValue([{ priority: 10, overrides: { version: '1' }, isActive: true }]),
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
        { priority: 10, overrides: { secureImageLinks: true }, isActive: true },
      ]);
      const config = await getAppConfig({ role: 'ADMIN' });

      expect(mockGetConfigs).toHaveBeenCalledTimes(2);
      expect((config as TestConfig).secureImageLinks).toBe(true);
    });

    it('does not short-circuit other users when one user has no overrides', async () => {
      const mockGetConfigs = jest.fn().mockResolvedValue([]);
      const deps = createDeps({ getApplicableConfigs: mockGetConfigs });
      const { getAppConfig } = createAppConfigService(deps);

      await getAppConfig({ role: 'USER' });
      expect(mockGetConfigs).toHaveBeenCalledTimes(1);

      mockGetConfigs.mockResolvedValueOnce([
        { priority: 10, overrides: { version: 'admin-only' }, isActive: true },
      ]);
      const config = await getAppConfig({ role: 'ADMIN' });

      expect(mockGetConfigs).toHaveBeenCalledTimes(2);
      expect((config as TestConfig).version).toBe('admin-only');
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
            .mockResolvedValue([
              { priority: 5, overrides: { secureImageLinks: true }, isActive: true },
            ]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        const config = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig(),
        );

        expect(deps.getApplicableConfigs).toHaveBeenCalledWith([]);
        expect((config as TestConfig).secureImageLinks).toBe(true);
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
            .mockResolvedValue([{ priority: 10, overrides: { version: '1' }, isActive: true }]),
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
              { priority: 10, overrides: { version: getTenantId() }, isActive: true },
            ]),
        });
        const { getAppConfig } = createAppConfigService(deps);

        const configA = (await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          getAppConfig({ role: 'USER' }),
        )) as TestConfig;
        const configB = (await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
          getAppConfig({ role: 'USER' }),
        )) as TestConfig;

        expect(configA.version).toBe('tenant-a');
        expect(configB.version).toBe('tenant-b');
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

    /** A reload that read librechat.yaml before a clear must not be what the clear leaves cached. */
    describe('while a reload is in flight', () => {
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      const stale = {
        version: 'stale',
        availableTools: { staleTool: {} },
      } as unknown as TestConfig;
      const fresh = {
        version: 'fresh',
        availableTools: { freshTool: {} },
      } as unknown as TestConfig;

      async function startStaleReload() {
        const deps = createDeps();
        const service = createAppConfigService(deps);
        await service.getAppConfig({ baseOnly: true });
        await service.clearAppConfigCache();
        let settleStale: (outcome: AppConfig | Error) => void = () => undefined;
        deps.loadBaseConfig
          .mockImplementationOnce(
            () =>
              new Promise<AppConfig>((resolve, reject) => {
                settleStale = (outcome) =>
                  outcome instanceof Error ? reject(outcome) : resolve(outcome);
              }),
          )
          .mockResolvedValue(fresh);
        const staleRead = service.getAppConfig({ baseOnly: true });
        await tick();
        await service.clearAppConfigCache();
        return { deps, service, staleRead, settleStale };
      }

      it('starts a new reload once the stale one settles, and caches only the new one', async () => {
        const { deps, service, staleRead, settleStale } = await startStaleReload();

        const freshRead = service.getAppConfig({ baseOnly: true });
        await tick();
        expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
        settleStale(stale);

        expect(((await staleRead) as TestConfig).version).toBe('stale');
        expect(((await freshRead) as TestConfig).version).toBe('fresh');
        expect(deps.loadBaseConfig).toHaveBeenCalledTimes(3);
        expect(((await service.getAppConfig({ baseOnly: true })) as TestConfig).version).toBe(
          'fresh',
        );
        expect(deps.loadBaseConfig).toHaveBeenCalledTimes(3);
        expect(deps.setCachedTools).not.toHaveBeenCalledWith(stale.availableTools);
        expect(deps.setCachedTools).toHaveBeenLastCalledWith(fresh.availableTools);
      });

      it('leaves the base uncached when the stale reload settles first', async () => {
        const { deps, service, staleRead, settleStale } = await startStaleReload();

        settleStale(stale);
        await staleRead;

        expect(deps._cache._store.has('app_config:_BASE_')).toBe(false);
        expect(((await service.getAppConfig({ baseOnly: true })) as TestConfig).version).toBe(
          'fresh',
        );
      });

      it('does not restore the last good config over the clear when the stale reload fails', async () => {
        const { deps, service, staleRead, settleStale } = await startStaleReload();

        settleStale(new Error('remote fetch failure'));

        expect(await staleRead).toEqual(deps._baseConfig);
        expect(deps._cache._store.has('app_config:_BASE_')).toBe(false);
        expect(((await service.getAppConfig({ baseOnly: true })) as TestConfig).version).toBe(
          'fresh',
        );
      });
    });

    /** An async store (Redis) can land a write after the delete of a clear that overtook it. */
    describe('when the cache write lands after the clear', () => {
      const tick = () => new Promise((resolve) => setImmediate(resolve));

      function holdNextSet(cache: ReturnType<typeof createMockCache>, prefix: string) {
        let release: (() => void) | undefined;
        cache.set.mockImplementationOnce((setKey, value) => {
          expect(setKey.startsWith(prefix)).toBe(true);
          return new Promise((resolve) => {
            release = () => {
              cache._store.set(`app_config:${setKey}`, value);
              resolve(undefined);
            };
          });
        });
        return async () => {
          while (!release) {
            await tick();
          }
          return release;
        };
      }

      it('removes the overtaken base so the next read reloads', async () => {
        const deps = createDeps({
          loadBaseConfig: jest
            .fn()
            .mockResolvedValueOnce({ version: 'first' })
            .mockResolvedValueOnce({ version: 'stale' })
            .mockResolvedValue({ version: 'fresh' }),
        });
        const service = createAppConfigService(deps);
        await service.getAppConfig({ baseOnly: true });
        await service.clearAppConfigCache();
        const held = holdNextSet(deps._cache, '_BASE_');

        const staleRead = service.getAppConfig({ baseOnly: true });
        const release = await held();
        await service.clearAppConfigCache();
        release();

        expect(((await staleRead) as TestConfig).version).toBe('stale');
        expect(deps._cache._store.has('app_config:_BASE_')).toBe(false);
        expect(((await service.getAppConfig({ baseOnly: true })) as TestConfig).version).toBe(
          'fresh',
        );
      });

      it('removes the overtaken merge so the next read merges again', async () => {
        const deps = createDeps({
          getApplicableConfigs: jest
            .fn()
            .mockResolvedValueOnce([
              { priority: 10, overrides: { version: 'stale' }, isActive: true },
            ])
            .mockResolvedValue([{ priority: 10, overrides: { version: 'fresh' }, isActive: true }]),
        });
        const service = createAppConfigService(deps);
        await service.getAppConfig({ baseOnly: true });
        const held = holdNextSet(deps._cache, '_OVERRIDE_:__default__:global:ADMIN:');

        const staleRead = service.getAppConfig({ role: 'ADMIN' });
        const release = await held();
        await service.clearOverrideCache();
        release();

        expect(((await staleRead) as TestConfig).version).toBe('stale');
        expect(((await service.getAppConfig({ role: 'ADMIN' })) as TestConfig).version).toBe(
          'fresh',
        );
        expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
      });
    });

    it('does not cache a merge built on the base it read before the clear', async () => {
      let releasePrincipals: (principals: unknown[]) => void = () => undefined;
      const principals = [{ principalType: 'role', principalId: 'USER' }];
      const deps = createDeps({
        loadBaseConfig: jest
          .fn()
          .mockResolvedValueOnce({ version: 'before' })
          .mockResolvedValue({ version: 'after' }),
        getUserPrincipals: jest
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (releasePrincipals = resolve)))
          .mockResolvedValue(principals),
      });
      const { getAppConfig, clearAppConfigCache } = createAppConfigService(deps);
      await getAppConfig({ baseOnly: true });

      const inFlight = getAppConfig({ role: 'USER', userId: 'uid1' });
      await new Promise((resolve) => setImmediate(resolve));
      await clearAppConfigCache();
      releasePrincipals(principals);
      expect(((await inFlight) as TestConfig).version).toBe('before');

      const next = (await getAppConfig({ role: 'USER', userId: 'uid1' })) as TestConfig;

      expect(next.version).toBe('after');
    });
  });

  describe('reloadBaseConfig', () => {
    const invalidFile = () =>
      new ConfigReloadError('Invalid custom config file', undefined, [
        { code: 'unrecognized_keys', keys: ['bogusTopLevelKey'], path: [], message: 'bogus' },
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['interface', 'customWelcome'],
          message: 'Expected string, received number',
        },
      ]);

    it('loads librechat.yaml again after a clear and reports it loaded', async () => {
      const deps = createDeps();
      const { getAppConfig, clearAppConfigCache, reloadBaseConfig } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      const next = { ...initial, interfaceConfig: { modelSelect: false } };
      deps.loadBaseConfig.mockResolvedValueOnce(next);

      await clearAppConfigCache();
      await expect(reloadBaseConfig()).resolves.toEqual({ ok: true });

      expect(deps.loadBaseConfig).toHaveBeenLastCalledWith('reload');
      expect(await getAppConfig({ baseOnly: true })).toEqual(next);
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(2);
    });

    it('reports a refused file by location and zod code, keeping the last good config', async () => {
      jest.spyOn(logger, 'error').mockReturnValue(logger);
      const deps = createDeps();
      const { getAppConfig, clearAppConfigCache, reloadBaseConfig } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      deps.loadBaseConfig.mockRejectedValueOnce(invalidFile());

      await clearAppConfigCache();
      const result = await reloadBaseConfig();

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'CONFIG_INVALID',
          issues: [
            { path: 'bogusTopLevelKey', segments: ['bogusTopLevelKey'], code: 'unrecognized_keys' },
            {
              path: 'interface.customWelcome',
              segments: ['interface', 'customWelcome'],
              code: 'invalid_type',
            },
          ],
        },
      });
      expect(JSON.stringify(result)).not.toContain('Expected string');
      expect(deps._cache._store.get('app_config:_BASE_')).toBe(initial);
      expect(await getAppConfig({ baseOnly: true })).toBe(initial);
    });

    it('loads again and reports the failure when a read already restored the last good config', async () => {
      jest.spyOn(logger, 'error').mockReturnValue(logger);
      const deps = createDeps();
      const { getAppConfig, clearAppConfigCache, reloadBaseConfig } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      deps.loadBaseConfig.mockRejectedValue(invalidFile());

      await clearAppConfigCache();
      expect(await getAppConfig({ baseOnly: true })).toBe(initial);
      const result = await reloadBaseConfig();

      expect(result).toMatchObject({ ok: false, error: { code: 'CONFIG_INVALID' } });
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(3);
    });

    it('reports a failure to build the config from a file that loaded as LOAD_FAILED', async () => {
      jest.spyOn(logger, 'error').mockReturnValue(logger);
      const deps = createDeps();
      const { getAppConfig, clearAppConfigCache, reloadBaseConfig } = createAppConfigService(deps);
      const initial = await getAppConfig({ baseOnly: true });
      deps.loadBaseConfig.mockRejectedValueOnce(new Error('AppService failed: secret detail'));

      await clearAppConfigCache();
      const result = await reloadBaseConfig();

      expect(result).toEqual({ ok: false, error: { code: 'LOAD_FAILED' } });
      expect(await getAppConfig({ baseOnly: true })).toBe(initial);
    });

    it('resolves with the failure instead of rejecting when there is no last good config', async () => {
      jest.spyOn(logger, 'error').mockReturnValue(logger);
      const deps = createDeps();
      deps.loadBaseConfig.mockRejectedValueOnce(invalidFile());
      const { reloadBaseConfig } = createAppConfigService(deps);

      await expect(reloadBaseConfig()).resolves.toMatchObject({
        ok: false,
        error: { code: 'CONFIG_INVALID' },
      });
    });
  });

  describe('clearOverrideCache', () => {
    it('clears all override caches when no tenantId is provided', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { version: '1' }, isActive: true }]),
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
          .mockResolvedValue([{ priority: 10, overrides: { version: '1' }, isActive: true }]),
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

    /** A merge that read the database before a clear must not be cached after it. */
    it.each([
      ['every tenant', undefined, 'tenant-a'],
      ['the same tenant', 'tenant-a', 'tenant-a'],
    ])('drops a merge read before a clear of %s', async (_label, cleared, tenantId) => {
      let releaseRead: (configs: unknown[]) => void = () => undefined;
      const stale = [{ priority: 10, overrides: { version: 'stale' }, isActive: true }];
      const fresh = [{ priority: 10, overrides: { version: 'fresh' }, isActive: true }];
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (releaseRead = resolve)))
          .mockResolvedValue(fresh),
      });
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      const inFlight = getAppConfig({ role: 'ADMIN', tenantId });
      await new Promise((resolve) => setImmediate(resolve));
      await clearOverrideCache(cleared);
      releaseRead(stale);
      expect(((await inFlight) as TestConfig).version).toBe('stale');

      const next = (await getAppConfig({ role: 'ADMIN', tenantId })) as TestConfig;

      expect(next.version).toBe('fresh');
      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
    });

    it('still caches a merge when only another tenant was cleared meanwhile', async () => {
      let releaseRead: (configs: unknown[]) => void = () => undefined;
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (releaseRead = resolve)))
          .mockResolvedValue([]),
      });
      const { getAppConfig, clearOverrideCache } = createAppConfigService(deps);

      const inFlight = getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });
      await new Promise((resolve) => setImmediate(resolve));
      await clearOverrideCache('tenant-b');
      releaseRead([{ priority: 10, overrides: { version: '1' }, isActive: true }]);
      await inFlight;
      await getAppConfig({ role: 'ADMIN', tenantId: 'tenant-a' });

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });
  });

  describe('bypassOverrideCache', () => {
    it('merges the stored overrides now and neither reads nor fills the cache', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValueOnce([
            { priority: 10, overrides: { version: 'first' }, isActive: true },
          ])
          .mockResolvedValueOnce([
            { priority: 10, overrides: { version: 'second' }, isActive: true },
          ])
          .mockResolvedValue([{ priority: 10, overrides: { version: 'third' }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);

      const cached = (await getAppConfig({ role: 'ADMIN' })) as TestConfig;
      deps._cache.set.mockClear();
      const bypassed = (await getAppConfig({
        role: 'ADMIN',
        bypassOverrideCache: true,
      })) as TestConfig;
      const again = (await getAppConfig({ role: 'ADMIN' })) as TestConfig;

      expect(cached.version).toBe('first');
      expect(bypassed.version).toBe('second');
      expect(again.version).toBe('first');
      expect(deps._cache.set).not.toHaveBeenCalled();
      expect(deps.loadBaseConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolvedPrincipals without a user id', () => {
    it('is never served from or written to the role-keyed cache', async () => {
      const deps = createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { version: '1' }, isActive: true }]),
      });
      const { getAppConfig } = createAppConfigService(deps);
      const resolvedPrincipals = [{ principalType: 'group', principalId: 'g1' }];

      await getAppConfig({ role: 'ADMIN' });
      deps._cache.set.mockClear();
      await getAppConfig({ role: 'ADMIN', resolvedPrincipals } as never);

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(2);
      expect(deps.getApplicableConfigs).toHaveBeenLastCalledWith(resolvedPrincipals);
      expect(deps._cache.set).not.toHaveBeenCalled();
    });

    it('is cached under the key of the user it was resolved for', async () => {
      const deps = createDeps();
      const { getAppConfig } = createAppConfigService(deps);
      const resolvedPrincipals = [{ principalType: 'user', principalId: 'uid1' }];

      await getAppConfig({ role: 'USER', userId: 'uid1', resolvedPrincipals } as never);
      await getAppConfig({ role: 'USER', userId: 'uid1', resolvedPrincipals } as never);

      expect(deps.getApplicableConfigs).toHaveBeenCalledTimes(1);
    });
  });

  describe('overrideCacheTtl', () => {
    const overrideDeps = (overrides = {}) =>
      createDeps({
        getApplicableConfigs: jest
          .fn()
          .mockResolvedValue([{ priority: 10, overrides: { version: '1' }, isActive: true }]),
        ...overrides,
      });

    it('reports the TTL it caches merged configs for', async () => {
      const deps = overrideDeps({ overrideCacheTtl: 15_000 });
      const service = createAppConfigService(deps);

      await service.getAppConfig({ role: 'ADMIN' });

      expect(service.overrideCacheTtl).toBe(15_000);
      expect(deps._cache.set).toHaveBeenCalledWith(
        expect.stringContaining('ADMIN'),
        expect.anything(),
        15_000,
      );
    });

    it('reports the default TTL when none is configured', async () => {
      const deps = overrideDeps();
      const service = createAppConfigService(deps);

      await service.getAppConfig({ role: 'ADMIN' });

      expect(service.overrideCacheTtl).toBe(DEFAULT_OVERRIDE_CACHE_TTL);
      expect(deps._cache.set).toHaveBeenCalledWith(
        expect.stringContaining('ADMIN'),
        expect.anything(),
        DEFAULT_OVERRIDE_CACHE_TTL,
      );
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

describe('what getAppConfig derives again for the parts profiles write', () => {
  type Yaml = NonNullable<Parameters<typeof AppService>[0]>['config'];
  const spec = (name: string, endpoint: string) => ({
    name,
    label: name,
    preset: { endpoint, model: 'm' },
  });
  const profile = (overrides: Record<string, unknown>, tombstones: string[] = []) => ({
    principalType: PrincipalType.ROLE,
    principalId: 'USER',
    priority: 10,
    isActive: true,
    overrides,
    tombstones,
  });
  function serviceOver(
    yaml: Record<string, unknown>,
    layers: ReturnType<typeof profile>[],
    options: { rederiveEndpoints?: boolean } = {},
  ) {
    return createAppConfigService(
      createDeps({
        loadBaseConfig: () =>
          AppService({ config: structuredClone(yaml) as Yaml, expandCustomEndpoint }),
        getApplicableConfigs: jest.fn().mockResolvedValue(layers),
        ...options,
      }),
    );
  }
  const specControls = (config: AppConfig) => {
    const { modelSelect, parameters, presets } = config.interfaceConfig ?? {};
    return { modelSelect, parameters, presets };
  };
  const ON = { modelSelect: true, parameters: true, presets: true };
  const OFF = { modelSelect: false, parameters: false, presets: false };

  it('turns the spec-dependent interface controls off for a profile that adds specs', async () => {
    const added = await serviceOver({}, [
      profile({ modelSpecs: { list: [spec('s', 'openAI')] } }),
    ]).getAppConfig({ role: 'USER' });
    const withEndpoints = await serviceOver({}, [
      profile({ modelSpecs: { list: [spec('s', 'openAI')], addedEndpoints: ['openAI'] } }),
    ]).getAppConfig({ role: 'USER' });
    const explicit = await serviceOver({}, [
      profile({ modelSpecs: { list: [spec('s', 'openAI')] }, interface: { parameters: true } }),
    ]).getAppConfig({ role: 'USER' });

    expect(specControls(await serviceOver({}, []).getAppConfig({ role: 'USER' }))).toEqual(ON);
    expect(specControls(added)).toEqual(OFF);
    expect(specControls(withEndpoints)).toEqual({ ...OFF, modelSelect: true });
    expect(specControls(explicit)).toEqual({ ...OFF, parameters: true });
  });

  it('turns them back on when a profile removes every spec librechat.yaml serves', async () => {
    const yaml = { modelSpecs: { list: [spec('s', 'openAI')] } };
    const tombstoned = await serviceOver(yaml, [profile({}, ['modelSpecs'])]).getAppConfig({
      role: 'USER',
    });
    const emptied = await serviceOver(yaml, [profile({ modelSpecs: { list: [] } })]).getAppConfig({
      role: 'USER',
    });

    expect(specControls(await serviceOver(yaml, []).getAppConfig({ role: 'USER' }))).toEqual(OFF);
    expect(specControls(tombstoned)).toEqual(ON);
    expect(specControls(emptied)).toEqual(ON);
  });

  it('derives a control a profile unsets from the specs it is served', async () => {
    const yaml = {
      interface: { parameters: true, presets: true },
      modelSpecs: { list: [spec('s', 'openAI')] },
    };
    const unset = await serviceOver(yaml, [profile({}, ['interface.parameters'])]).getAppConfig({
      role: 'USER',
    });
    const unsetWithoutSpecs = await serviceOver(yaml, [
      profile({}, ['interface.parameters', 'modelSpecs']),
    ]).getAppConfig({ role: 'USER' });

    expect(specControls(await serviceOver(yaml, []).getAppConfig({ role: 'USER' }))).toEqual({
      modelSelect: false,
      parameters: true,
      presets: true,
    });
    expect(specControls(unset)).toEqual({ modelSelect: false, parameters: false, presets: true });
    expect(specControls(unsetWithoutSpecs)).toEqual(ON);
  });

  describe('a control one profile sets and another tombstones', () => {
    const above = (tombstones: string[]) => ({ ...profile({}, tombstones), priority: 20 });
    const served = async (yaml: Record<string, unknown>, layers: ReturnType<typeof profile>[]) =>
      specControls(await serviceOver(yaml, layers).getAppConfig({ role: 'USER' }));
    const withSpecs = { modelSpecs: { list: [spec('s', 'openAI')] } };

    it('derives it from the specs served once a higher profile tombstones it', async () => {
      const hidden = profile({ interface: { parameters: false, presets: false } });
      const shown = profile({ interface: { parameters: true } });
      const tombstone = above(['interface.parameters', 'interface.presets']);

      expect(await served({}, [hidden])).toEqual({ ...ON, parameters: false, presets: false });
      expect(await served({}, [hidden, tombstone])).toEqual(ON);
      expect(await served(withSpecs, [shown])).toEqual({ ...OFF, parameters: true });
      expect(await served(withSpecs, [shown, above(['interface.parameters'])])).toEqual(OFF);
    });

    it('derives it where a profile tombstones a control librechat.yaml leaves unset', async () => {
      expect(await served({}, [profile({}, ['interface.parameters'])])).toEqual(ON);
      expect(await served(withSpecs, [profile({}, ['interface.modelSelect'])])).toEqual(OFF);
    });

    it('keeps what a higher profile sets over a lower tombstone of it', async () => {
      const tombstone = profile({}, ['interface.parameters']);
      const sets = (parameters: boolean) => ({
        ...profile({ interface: { parameters } }),
        priority: 20,
      });

      expect(await served({}, [tombstone, sets(false)])).toEqual({ ...ON, parameters: false });
      expect(await served(withSpecs, [tombstone, sets(true)])).toEqual({
        ...OFF,
        parameters: true,
      });
      expect(
        await served({ ...withSpecs, interface: { parameters: true } }, [tombstone, sets(true)]),
      ).toEqual({ ...OFF, parameters: true });
    });

    it('follows the specs the profiles leave, added then tombstoned or the reverse', async () => {
      const adds = (priority: number) => ({
        ...profile({ modelSpecs: { list: [spec('s2', 'openAI')] } }),
        priority,
      });
      const tombstone = (priority: number) => ({ ...profile({}, ['modelSpecs']), priority });

      expect(await served({}, [adds(10), tombstone(20)])).toEqual(ON);
      expect(await served(withSpecs, [tombstone(10), adds(20)])).toEqual(OFF);
    });
  });

  it("turns them back on when tenant scoping hides the only endpoint a profile's specs use", async () => {
    const yaml = {
      endpoints: {
        custom: [
          {
            name: 'TenantOnly',
            tenantId: 'tenant-a',
            apiKey: 'k',
            baseURL: 'https://t',
            models: { default: ['m'] },
          },
        ],
      },
    };
    const service = serviceOver(yaml, [
      profile({ modelSpecs: { list: [spec('s', 'TenantOnly')] } }),
    ]);

    const owner = await service.getAppConfig({ role: 'USER', tenantId: 'tenant-a' });
    const other = await service.getAppConfig({ role: 'USER', tenantId: 'tenant-b' });

    expect(specControls(owner)).toEqual(OFF);
    expect(other.modelSpecs).toBeUndefined();
    expect(specControls(other)).toEqual(ON);
  });

  it('expands the parameters a profile writes, and OpenRouter defaults for an endpoint only it defines', async () => {
    const gateway = {
      name: 'Gateway',
      apiKey: 'gateway-key',
      baseURL: 'https://gateway.example.com/v1',
      models: { default: ['m1'] },
      customParams: {
        defaultParamsEndpoint: 'anthropic',
        paramDefinitions: [{ key: 'temperature', default: 0.2 }],
      },
    };
    const service = serviceOver({ endpoints: { custom: [gateway] } }, [
      profile({
        endpoints: {
          custom: [
            { name: 'Gateway', customParams: { defaultParamsEndpoint: 'openAI' } },
            {
              ...gateway,
              name: 'Router',
              baseURL: 'https://openrouter.ai/api/v1',
              customParams: undefined,
            },
          ],
        },
      }),
    ]);

    const base = await service.getAppConfig({ baseOnly: true });
    const config = await service.getAppConfig({ role: 'USER' });
    const served = (name: string) => config.endpoints?.custom?.find((entry) => entry.name === name);

    expect(base.config.endpoints?.custom?.[0]?.customParams).toEqual(gateway.customParams);
    expect(served('Gateway')?.customParams?.defaultParamsEndpoint).toBe('openAI');
    expect(served('Gateway')?.customParams?.paramDefinitions?.[0]).toMatchObject({
      key: 'temperature',
      default: 0.2,
      optionType: 'custom',
      component: 'slider',
    });
    expect(served('Router')?.customParams).toMatchObject({
      defaultParamsEndpoint: 'openrouter',
      paramDefinitions: [expect.objectContaining({ key: 'promptCache', default: true })],
    });
  });

  it('derives Vertex AI a profile writes only when the service re-derives endpoints', async () => {
    const yaml = {
      endpoints: {
        anthropic: {
          vertex: { projectId: 'yaml-project', region: 'us-east5', models: ['claude-sonnet-4-6'] },
        },
      },
    };
    const layers = [
      profile({ endpoints: { anthropic: { vertex: { models: ['claude-opus-4-6'] } } } }),
    ];
    const served = async (rederiveEndpoints: boolean) => {
      const service = serviceOver(yaml, layers, { rederiveEndpoints });
      expect(service.rederiveEndpoints).toBe(rederiveEndpoints);
      return (await service.getAppConfig({ role: 'USER' })).endpoints?.anthropic?.models;
    };

    expect(await served(false)).toEqual(['claude-sonnet-4-6']);
    expect(await served(true)).toEqual(['claude-opus-4-6']);
  });

  describe('Vertex AI settings a profile references a variable in', () => {
    const saved = { ...process.env };
    const yaml = {
      endpoints: {
        anthropic: { vertex: { projectId: '${GCP_PROJECT}', models: ['claude-sonnet-4-6'] } },
      },
    };
    const vertexOf = async (vertex: Record<string, unknown>) =>
      (
        await serviceOver(yaml, [profile({ endpoints: { anthropic: { vertex } } })], {
          rederiveEndpoints: true,
        }).getAppConfig({ role: 'USER' })
      ).endpoints?.anthropic?.vertexConfig;
    beforeEach(() => {
      process.env.OPENAI_API_KEY = 'sk-deployment-openai-key';
      process.env.GCP_PROJECT = 'yaml-gcp-project';
    });
    afterEach(() => {
      process.env = { ...saved };
    });

    it('never resolves a credential into the derived vertexConfig a read returns', async () => {
      const vertexConfig = await vertexOf({
        projectId: '${OPENAI_API_KEY}',
        deploymentName: '${OPENAI_API_KEY}',
        models: ['claude-opus-4-6'],
      });

      expect(vertexConfig?.modelNames).toEqual(['claude-opus-4-6']);
      expect(JSON.stringify(vertexConfig)).not.toContain('sk-deployment-openai-key');
      /** The reference resolves to nothing, as an unset variable: librechat.yaml's value stays. */
      expect(vertexConfig?.projectId).toBe('yaml-gcp-project');
      expect(vertexConfig?.deploymentName).toBeUndefined();
      expect(vertexConfig?.modelDeploymentMap).toEqual({ 'claude-opus-4-6': 'claude-opus-4-6' });
    });

    it("resolves the variables librechat.yaml's own Vertex AI settings reference", async () => {
      const vertexConfig = await vertexOf({
        deploymentName: '${GCP_PROJECT}',
        models: ['claude-opus-4-6'],
      });

      expect(vertexConfig?.projectId).toBe('yaml-gcp-project');
      expect(vertexConfig?.modelDeploymentMap).toEqual({ 'claude-opus-4-6': 'yaml-gcp-project' });
    });
  });

  /**
   * Every part the merge derives again, judged on what the layers leave: for each way a layer
   * changes its inputs (a set, an unset, a tombstone of the path and of each object above it, a
   * higher layer recreating what such a tombstone removed, the Base profile on either side, tenant
   * scoping), the served part is what startup derives from the librechat.yaml the layers leave
   * (`as`), or, where no librechat.yaml loads to it, the value given (`expected`).
   */
  describe('each derived part follows what the layers leave', () => {
    type Layer = ReturnType<typeof profile>;
    type Yaml = Record<string, unknown>;
    type Probe = (config: AppConfig) => unknown;
    interface Cell {
      change: string;
      layers: Layer[];
      as?: Yaml;
      expected?: unknown;
      yaml?: Yaml;
      rederiveEndpoints?: boolean;
      tenantId?: string;
    }
    const base = (overrides: Yaml = {}, tombstones: string[] = []): Layer => ({
      ...profile(overrides, tombstones),
      principalId: BASE_CONFIG_PRINCIPAL_ID,
      priority: 0,
    });
    const role = (overrides: Yaml = {}, tombstones: string[] = []): Layer =>
      profile(overrides, tombstones);
    const above = (overrides: Yaml = {}, tombstones: string[] = []): Layer => ({
      ...profile(overrides, tombstones),
      principalId: 'ADMIN',
      priority: 20,
    });
    /** `yaml` with `value` at a dotted path, or without what is there for `undefined`. */
    const at = (yaml: Yaml, path: string, value?: unknown): Yaml => {
      const [key, ...rest] = path.split('.');
      const next = { ...yaml };
      if (rest.length > 0) {
        next[key] = at((yaml[key] as Yaml | undefined) ?? {}, rest.join('.'), value);
      } else if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    };
    const write = (path: string, value: unknown): Yaml => at({}, path, value);

    const AZURE = 'endpoints.azureOpenAI';
    const GROUPS = `${AZURE}.groups`;
    const ASSISTANTS = `${AZURE}.assistants`;
    const ANTHROPIC = 'endpoints.anthropic';
    const VERTEX = `${ANTHROPIC}.vertex`;
    const MODELS = `${ANTHROPIC}.models`;
    const CUSTOM = 'endpoints.custom';
    const AGENTS = 'endpoints.agents';
    const east = {
      group: 'east',
      apiKey: 'east-key',
      instanceName: 'east',
      version: '2024-10-21',
      deploymentName: 'gpt-4o',
      assistants: true,
      models: { 'gpt-4o': true },
    };
    const west = {
      group: 'west',
      apiKey: 'west-key',
      instanceName: 'west',
      version: '2024-10-21',
      deploymentName: 'gpt-5',
      models: { 'gpt-5': true },
    };
    const yamlVertex = {
      projectId: 'yaml-project',
      region: 'us-east5',
      models: ['claude-sonnet-4-6'],
    };
    const profileVertex = { projectId: 'profile-project', models: ['claude-opus-4-6'] };
    /** Loads only with a default deployment name: the model name is not one path segment. */
    const namedVertex = { ...yamlVertex, models: { 'Claude Team': true } };
    const gateway = {
      name: 'Gateway',
      apiKey: 'gateway-key',
      baseURL: 'https://gateway.example.com/v1',
      models: { default: ['m1'] },
      customParams: {
        defaultParamsEndpoint: 'anthropic',
        paramDefinitions: [{ key: 'temperature', default: 0.2 }],
      },
    };
    const openAIGateway = {
      ...gateway,
      customParams: { ...gateway.customParams, defaultParamsEndpoint: 'openAI' },
    };
    const router = {
      name: 'Router',
      apiKey: 'router-key',
      baseURL: 'https://openrouter.ai/api/v1',
      models: { default: ['m1'] },
    };
    const YAML: Yaml = {
      endpoints: {
        azureOpenAI: { assistants: true, groups: [east] },
        anthropic: { models: ['claude-direct'], vertex: yamlVertex },
        custom: [gateway],
      },
      memory: { disabled: true },
      modelSpecs: { list: [spec('s', 'openAI')] },
    };
    const tenantOnly = {
      name: 'TenantOnly',
      tenantId: 'tenant-a',
      apiKey: 'tenant-key',
      baseURL: 'https://tenant.example.com/v1',
      models: { default: ['m1'] },
    };
    const TENANT_YAML: Yaml = {
      endpoints: { custom: [tenantOnly] },
      modelSpecs: { list: [spec('s', 'TenantOnly')] },
    };

    const azure: Probe = ({ endpoints }) => {
      const served = endpoints?.azureOpenAI;
      return {
        azureAssistants: endpoints?.azureAssistants != null,
        azure: served && {
          groups:
            served.groupMap &&
            Object.fromEntries(
              Object.entries(served.groupMap).map(([name, group]) => [
                name,
                { instanceName: group?.instanceName, keyed: group?.apiKey != null },
              ]),
            ),
          modelGroupMap: served.modelGroupMap,
          models: served.modelNames,
          assistantModels: served.assistantModels,
          assistantGroups: served.assistantGroups,
          assistants: Boolean(served.assistants),
        },
      };
    };
    const NO_GROUP = {
      azureAssistants: false,
      azure: {
        groups: {},
        modelGroupMap: {},
        models: [],
        assistantModels: [],
        assistantGroups: [],
        assistants: false,
      },
    };
    const anthropic: Probe = ({ endpoints }) => {
      const served = endpoints?.anthropic;
      const vertexConfig = served?.vertexConfig;
      return {
        models: served?.models,
        vertex: vertexConfig && {
          modelNames: vertexConfig.modelNames,
          projectId: vertexConfig.projectId,
          region: vertexConfig.region,
        },
      };
    };
    const customParams: Probe = ({ endpoints }) =>
      Object.fromEntries(
        (endpoints?.custom ?? []).map((entry) => [entry.name, entry.customParams ?? null]),
      );
    const agents: Probe = ({ endpoints }) =>
      endpoints?.agents && { capabilities: endpoints.agents.capabilities };
    const specsServed: Probe = (config) => ({
      list: config.modelSpecs?.list?.map(({ name, preset }) => [name, preset?.endpoint]),
      addedEndpoints: config.modelSpecs?.addedEndpoints,
      controls: specControls(config),
    });
    const SPECS = 'modelSpecs';
    const OPENAI = 'endpoints.openAI';
    /** Specs on the custom endpoint and on each built-in endpoint a layer may tombstone. */
    const SPEC_YAML = at(at(YAML, OPENAI, { titleModel: 'gpt-4o-mini' }), SPECS, {
      list: [
        spec('g', 'Gateway'),
        spec('o', 'openAI'),
        spec('az', 'azureOpenAI'),
        spec('an', 'anthropic'),
      ],
      addedEndpoints: ['Gateway', 'openAI'],
    });
    /**
     * Startup keeps an `addedEndpoints` name whose endpoint is gone; a custom endpoint the layers
     * remove also leaves it (`keyedTombstones`), and the other names stay.
     */
    const withoutGateway = (yaml: Yaml): Yaml => at(yaml, `${SPECS}.addedEndpoints`, ['openAI']);
    /** Specs only on the custom endpoint, so removing it leaves none. */
    const GATEWAY_SPECS = at(YAML, SPECS, { list: [spec('g', 'Gateway')] });
    const onSpecs = (cell: Cell): Cell => ({ yaml: SPEC_YAML, ...cell });
    /**
     * A built-in endpoint's specs stay when a layer tombstones its settings, as startup keeps
     * them for a librechat.yaml without them: the endpoint is still offered.
     */
    const builtInSpecCells = (
      [
        [OPENAI, write(`${OPENAI}.titleModel`, 'gpt-4o'), { titleModel: 'gpt-4o' }],
        [AZURE, write(GROUPS, [west]), { groups: [west] }],
        [ANTHROPIC, write(`${ANTHROPIC}.titleModel`, 'claude-x'), { titleModel: 'claude-x' }],
      ] as const
    ).flatMap(([path, recreate, recreated]): Cell[] =>
      [
        { change: `tombstone of ${path}`, layers: [role({}, [path])], as: at(SPEC_YAML, path) },
        {
          change: `Base's tombstone of ${path}, unset by the profile above`,
          layers: [base({}, [path]), role()],
          as: at(SPEC_YAML, path),
        },
        {
          change: `${path} recreated by a profile after Base tombstones it`,
          layers: [base({}, [path]), role(recreate)],
          as: at(SPEC_YAML, path, recreated),
        },
      ].map(onSpecs),
    );

    const matrix: Array<[string, Probe, Cell[]]> = [
      [
        'Azure groups and assistants (the groupMap, model lists and the Azure Assistants endpoint)',
        azure,
        [
          {
            change: 'set by Base',
            layers: [base(write(GROUPS, [west]))],
            as: at(YAML, GROUPS, [east, west]),
          },
          {
            change: 'set by a profile over Base, merged by group',
            layers: [
              base(write(GROUPS, [west])),
              role(write(GROUPS, [{ group: 'west', models: { 'gpt-5-mini': true } }])),
            ],
            as: at(YAML, GROUPS, [
              east,
              { ...west, models: { 'gpt-5': true, 'gpt-5-mini': true } },
            ]),
          },
          {
            change: 'set by Base, unset by the profile above',
            layers: [base(write(GROUPS, [west])), role()],
            as: at(YAML, GROUPS, [east, west]),
          },
          { change: 'tombstone of the path', layers: [role({}, [GROUPS])], expected: NO_GROUP },
          {
            change: "a profile's tombstone of the path over Base's groups",
            layers: [base(write(GROUPS, [west])), role({}, [GROUPS])],
            expected: NO_GROUP,
          },
          {
            change: 'tombstone of the endpoint',
            layers: [role({}, [AZURE])],
            as: at(YAML, AZURE),
          },
          {
            change: 'tombstone of endpoints',
            layers: [role({}, ['endpoints'])],
            as: at(YAML, 'endpoints'),
          },
          {
            change: 'recreated by a profile after Base tombstones the endpoint',
            layers: [base({}, [AZURE]), role(write(`${AZURE}.titleModel`, 'gpt-4o'))],
            expected: NO_GROUP,
          },
          {
            change: 'recreated by a profile after Base tombstones endpoints',
            layers: [base({}, ['endpoints']), role(write(`${AZURE}.titleModel`, 'gpt-4o'))],
            expected: NO_GROUP,
          },
          {
            change: 'recreated by the layer that tombstones the endpoint',
            layers: [role(write(`${AZURE}.titleModel`, 'gpt-4o'), [AZURE])],
            expected: NO_GROUP,
          },
          {
            change: "recreated over a lower profile's groups by a higher profile's tombstone",
            layers: [
              role(write(GROUPS, [west])),
              above(write(`${AZURE}.titleModel`, 'x'), [AZURE]),
            ],
            expected: NO_GROUP,
          },
          {
            change: 'recreated with assistants on after a tombstone of the endpoint',
            layers: [base({}, [AZURE]), role(write(ASSISTANTS, true))],
            expected: NO_GROUP,
          },
          {
            change: 'recreated with groups after a tombstone of the endpoint',
            layers: [base({}, [AZURE]), role(write(GROUPS, [west]))],
            as: at(YAML, AZURE, { groups: [west] }),
          },
          {
            change: 'recreated with groups after a tombstone of endpoints',
            layers: [base({}, ['endpoints']), role(write(GROUPS, [west]))],
            as: at(at(YAML, 'endpoints'), AZURE, { groups: [west] }),
          },
          {
            change: 'groups Base tombstones, set again by a profile',
            layers: [base({}, [GROUPS]), role(write(GROUPS, [west]))],
            as: at(YAML, AZURE, { groups: [west] }),
          },
          {
            change: 'assistants turned off',
            layers: [role(write(ASSISTANTS, false))],
            as: at(YAML, ASSISTANTS, false),
          },
          {
            change: 'assistants tombstoned',
            layers: [role({}, [ASSISTANTS])],
            as: at(YAML, ASSISTANTS),
          },
          {
            change: 'assistants Base turns off, tombstoned by a profile',
            layers: [base(write(ASSISTANTS, false)), role({}, [ASSISTANTS])],
            as: at(YAML, ASSISTANTS),
          },
          {
            change: 'assistants Base tombstones, turned on by a profile',
            layers: [base({}, [ASSISTANTS]), role(write(ASSISTANTS, true))],
            as: YAML,
          },
          {
            change: 'switch off: a profile sets groups (inert)',
            layers: [role(write(GROUPS, [west]))],
            rederiveEndpoints: false,
            as: YAML,
          },
          {
            change: 'switch off: tombstone of the path (inert)',
            layers: [role({}, [GROUPS])],
            rederiveEndpoints: false,
            as: YAML,
          },
          {
            change: 'switch off: tombstone of the endpoint (Azure Assistants not derived)',
            layers: [role({}, [AZURE])],
            rederiveEndpoints: false,
            expected: { azure: undefined, azureAssistants: true },
          },
          {
            change: 'switch off: recreated by a profile after Base tombstones the endpoint',
            layers: [base({}, [AZURE]), role(write(`${AZURE}.titleModel`, 'gpt-4o'))],
            rederiveEndpoints: false,
            expected: { ...NO_GROUP, azureAssistants: true },
          },
        ],
      ],
      [
        'Vertex AI and the Anthropic models (vertexConfig, endpoints.anthropic.models)',
        anthropic,
        [
          {
            change: 'set by a profile',
            layers: [role(write(`${VERTEX}.models`, ['claude-opus-4-6']))],
            as: at(YAML, `${VERTEX}.models`, ['claude-opus-4-6']),
          },
          {
            change: 'set by Base, unset by the profile above',
            layers: [base(write(`${VERTEX}.models`, ['claude-opus-4-6'])), role()],
            as: at(YAML, `${VERTEX}.models`, ['claude-opus-4-6']),
          },
          {
            change: 'turned off',
            layers: [role(write(`${VERTEX}.enabled`, false))],
            as: at(YAML, `${VERTEX}.enabled`, false),
          },
          {
            change: 'turned off by Base, tombstoned by a profile',
            layers: [base(write(`${VERTEX}.enabled`, false)), role({}, [`${VERTEX}.enabled`])],
            as: YAML,
          },
          { change: 'tombstone of the path', layers: [role({}, [VERTEX])], as: at(YAML, VERTEX) },
          {
            change: 'tombstone of one of its settings',
            layers: [role({}, [`${VERTEX}.models`])],
            as: at(YAML, `${VERTEX}.models`),
          },
          {
            change: 'tombstone of a setting it does not load without (off)',
            yaml: at(YAML, VERTEX, { ...namedVertex, deploymentName: 'claude-deploy' }),
            layers: [role({}, [`${VERTEX}.deploymentName`])],
            expected: { models: ['claude-direct'], vertex: undefined },
          },
          {
            change: 'tombstone of the endpoint',
            layers: [role({}, [ANTHROPIC])],
            as: at(YAML, ANTHROPIC),
          },
          {
            change: 'tombstone of endpoints',
            layers: [role({}, ['endpoints'])],
            as: at(YAML, 'endpoints'),
          },
          {
            change: 'recreated without Vertex AI after Base tombstones the endpoint',
            layers: [base({}, [ANTHROPIC]), role(write(`${ANTHROPIC}.titleModel`, 'claude-x'))],
            as: at(YAML, ANTHROPIC, { titleModel: 'claude-x' }),
          },
          {
            change: 'recreated with Vertex AI after Base tombstones the endpoint',
            layers: [base({}, [ANTHROPIC]), role(write(VERTEX, profileVertex))],
            as: at(YAML, ANTHROPIC, { vertex: { ...profileVertex, region: 'us-east5' } }),
          },
          {
            change: 'recreated with Vertex AI after Base tombstones endpoints',
            layers: [base({}, ['endpoints']), role(write(VERTEX, profileVertex))],
            as: at(at(YAML, 'endpoints'), VERTEX, { ...profileVertex, region: 'us-east5' }),
          },
          {
            change: "models a profile sets, over Vertex AI's",
            layers: [role(write(MODELS, ['claude-x']))],
            expected: {
              models: ['claude-x'],
              vertex: { ...yamlVertex, modelNames: yamlVertex.models, models: undefined },
            },
          },
          {
            change: 'models Base sets, tombstoned by a profile',
            layers: [base(write(MODELS, ['claude-x'])), role({}, [MODELS])],
            as: YAML,
          },
          {
            change: 'models Base tombstones, set by a profile',
            layers: [base({}, [MODELS]), role(write(MODELS, ['claude-y']))],
            expected: {
              models: ['claude-y'],
              vertex: { ...yamlVertex, modelNames: yamlVertex.models, models: undefined },
            },
          },
          {
            change: 'models Base sets, then the endpoint tombstoned and Vertex AI recreated',
            layers: [
              base(write(MODELS, ['claude-x'])),
              role(write(VERTEX, profileVertex), [ANTHROPIC]),
            ],
            as: at(YAML, ANTHROPIC, { vertex: { ...profileVertex, region: 'us-east5' } }),
          },
          {
            change: 'models Base sets, then endpoints tombstoned',
            layers: [base(write(MODELS, ['claude-x'])), role({}, ['endpoints'])],
            as: at(YAML, 'endpoints'),
          },
          {
            change: 'models Base sets, then Vertex AI tombstoned',
            layers: [base(write(MODELS, ['claude-x'])), role({}, [VERTEX])],
            as: at(at(YAML, VERTEX), MODELS, ['claude-x']),
          },
          {
            change: 'switch off: a profile sets Vertex AI (inert)',
            layers: [role(write(`${VERTEX}.models`, ['claude-opus-4-6']))],
            rederiveEndpoints: false,
            as: YAML,
          },
        ],
      ],
      [
        'custom endpoint parameters (each endpoint served with its customParams expanded)',
        customParams,
        [
          {
            change: 'set by a profile',
            layers: [
              role(
                write(CUSTOM, [
                  { name: 'Gateway', customParams: { defaultParamsEndpoint: 'openAI' } },
                ]),
              ),
            ],
            as: at(YAML, CUSTOM, [openAIGateway]),
          },
          {
            change: 'set by Base, unset by the profile above',
            layers: [
              base(
                write(CUSTOM, [
                  { name: 'Gateway', customParams: { defaultParamsEndpoint: 'openAI' } },
                ]),
              ),
              role(),
            ],
            as: at(YAML, CUSTOM, [openAIGateway]),
          },
          {
            change: 'an endpoint only a profile defines',
            layers: [role(write(CUSTOM, [router]))],
            as: at(YAML, CUSTOM, [gateway, router]),
          },
          { change: 'tombstone of the list', layers: [role({}, [CUSTOM])], as: at(YAML, CUSTOM) },
          {
            change: 'tombstone of endpoints',
            layers: [role({}, ['endpoints'])],
            as: at(YAML, 'endpoints'),
          },
          {
            change: 'recreated by a profile after Base tombstones the list',
            layers: [base({}, [CUSTOM]), role(write(CUSTOM, [router]))],
            as: at(YAML, CUSTOM, [router]),
          },
          {
            change: 'recreated by a profile after Base tombstones endpoints',
            layers: [base({}, ['endpoints']), role(write(CUSTOM, [openAIGateway]))],
            as: at(at(YAML, 'endpoints'), CUSTOM, [openAIGateway]),
          },
          {
            change: "a lower profile's parameters under a higher profile's tombstone of the list",
            layers: [role(write(CUSTOM, [openAIGateway])), above({}, [CUSTOM])],
            as: at(YAML, CUSTOM),
          },
          {
            change: "tenant scoping: the tenant's own endpoint",
            yaml: at(TENANT_YAML, 'modelSpecs'),
            layers: [
              role(
                write(CUSTOM, [
                  { name: 'TenantOnly', customParams: { defaultParamsEndpoint: 'anthropic' } },
                ]),
              ),
            ],
            tenantId: 'tenant-a',
            as: at(at(TENANT_YAML, 'modelSpecs'), CUSTOM, [
              { ...tenantOnly, customParams: { defaultParamsEndpoint: 'anthropic' } },
            ]),
          },
          {
            change: "tenant scoping: another tenant's endpoint stays hidden",
            yaml: at(TENANT_YAML, 'modelSpecs'),
            layers: [
              role(
                write(CUSTOM, [
                  { name: 'TenantOnly', customParams: { defaultParamsEndpoint: 'anthropic' } },
                ]),
              ),
            ],
            tenantId: 'tenant-b',
            as: at(TENANT_YAML, 'modelSpecs'),
          },
        ],
      ],
      [
        'the agents endpoint and its memory capability',
        agents,
        [
          {
            change: 'memory turned on',
            layers: [role(write('memory.disabled', false))],
            as: at(YAML, 'memory', { disabled: false }),
          },
          {
            change: 'memory Base turns on, unset by the profile above',
            layers: [base(write('memory.disabled', false)), role()],
            as: at(YAML, 'memory', { disabled: false }),
          },
          {
            change: 'memory Base turns on, memory.disabled tombstoned by a profile',
            layers: [base(write('memory.disabled', false)), role({}, ['memory.disabled'])],
            as: at(YAML, 'memory', {}),
          },
          {
            change: 'memory tombstoned',
            layers: [role({}, ['memory'])],
            as: at(YAML, 'memory'),
          },
          {
            change: 'memory Base turns on, tombstoned by a profile',
            layers: [base(write('memory.disabled', false)), role({}, ['memory'])],
            as: at(YAML, 'memory'),
          },
          {
            change: 'memory Base tombstones, turned on by a profile',
            layers: [base({}, ['memory']), role(write('memory.disabled', false))],
            as: at(YAML, 'memory', { disabled: false }),
          },
          {
            change: 'capabilities set',
            layers: [role(write(`${AGENTS}.capabilities`, ['memory', 'tools']))],
            as: at(YAML, `${AGENTS}.capabilities`, ['memory', 'tools']),
          },
          {
            change: 'capabilities Base sets, tombstoned by a profile',
            layers: [
              base(write(`${AGENTS}.capabilities`, ['tools'])),
              role({}, [`${AGENTS}.capabilities`]),
            ],
            as: YAML,
          },
          {
            change: 'tombstone of the agents endpoint',
            layers: [role({}, [AGENTS])],
            as: YAML,
          },
          {
            change: 'tombstone of endpoints',
            layers: [role({}, ['endpoints'])],
            as: at(YAML, 'endpoints'),
          },
          {
            change: 'recreated by a profile after Base tombstones the agents endpoint',
            layers: [base({}, [AGENTS]), role(write(`${AGENTS}.disableBuilder`, true))],
            as: at(YAML, AGENTS, { disableBuilder: true }),
          },
          {
            change: 'memory turned on by a profile after Base tombstones endpoints',
            layers: [base({}, ['endpoints']), role(write('memory.disabled', false))],
            as: at(at(YAML, 'endpoints'), 'memory', { disabled: false }),
          },
        ],
      ],
      [
        'the interface controls model specs decide (modelSelect, parameters, presets)',
        specControls,
        [
          {
            change: 'set by a profile',
            layers: [role(write('interface.parameters', true))],
            as: at(YAML, 'interface', { parameters: true }),
          },
          {
            change: 'set by Base, unset by the profile above',
            layers: [base(write('interface.parameters', true)), role()],
            as: at(YAML, 'interface', { parameters: true }),
          },
          {
            change: 'set by Base, tombstoned by a profile',
            layers: [base(write('interface.parameters', true)), role({}, ['interface.parameters'])],
            as: YAML,
          },
          {
            change: 'tombstone of the interface',
            layers: [role({}, ['interface'])],
            as: YAML,
          },
          {
            change: 'tombstone of the interface without specs',
            layers: [role({}, ['interface', 'modelSpecs'])],
            as: at(YAML, 'modelSpecs'),
          },
          {
            change: 'set by Base, the interface tombstoned by a profile',
            layers: [base(write('interface.parameters', true)), role({}, ['interface'])],
            as: YAML,
          },
          {
            change: 'recreated by a profile after Base tombstones the interface',
            layers: [base({}, ['interface']), role(write('interface.customWelcome', 'hi'))],
            as: YAML,
          },
          {
            change: 'set by a profile after Base tombstones the interface',
            layers: [base({}, ['interface']), role(write('interface.parameters', true))],
            as: at(YAML, 'interface', { parameters: true }),
          },
          {
            change: 'specs tombstoned',
            layers: [role({}, ['modelSpecs'])],
            as: at(YAML, 'modelSpecs'),
          },
          {
            change: 'the spec list tombstoned',
            layers: [role({}, ['modelSpecs.list'])],
            as: at(YAML, 'modelSpecs'),
          },
          {
            change: 'specs Base tombstones, added again by a profile',
            layers: [
              base({}, ['modelSpecs']),
              role(write('modelSpecs.list', [spec('s2', 'openAI')])),
            ],
            as: YAML,
          },
          {
            change: "tenant scoping: the tenant's own specs",
            yaml: TENANT_YAML,
            layers: [role(write('interface.customWelcome', 'hi'))],
            tenantId: 'tenant-a',
            as: TENANT_YAML,
          },
          {
            change: "tenant scoping: specs of another tenant's endpoint",
            yaml: TENANT_YAML,
            layers: [role(write('interface.customWelcome', 'hi'))],
            tenantId: 'tenant-b',
            as: TENANT_YAML,
          },
          {
            change: "tenant scoping: specs of another tenant's endpoint, the interface tombstoned",
            yaml: TENANT_YAML,
            layers: [role({}, ['interface'])],
            tenantId: 'tenant-b',
            as: TENANT_YAML,
          },
        ],
      ],
      [
        'model specs once the endpoints they name are removed (the specs served, addedEndpoints, the controls they decide)',
        specsServed,
        [
          ...[
            {
              change: 'tombstone of endpoints.custom',
              layers: [role({}, [CUSTOM])],
              as: withoutGateway(at(SPEC_YAML, CUSTOM)),
            },
            {
              change: "Base's tombstone of endpoints.custom, unset by the profile above",
              layers: [base({}, [CUSTOM]), role()],
              as: withoutGateway(at(SPEC_YAML, CUSTOM)),
            },
            {
              change: 'endpoints.custom Base adds to, tombstoned by a profile',
              layers: [base(write(CUSTOM, [router])), role({}, [CUSTOM])],
              as: withoutGateway(at(SPEC_YAML, CUSTOM)),
            },
            {
              change:
                "a profile's own endpoint and its spec under a higher profile's tombstone of endpoints.custom",
              layers: [
                role({
                  ...write(CUSTOM, [router]),
                  ...write(`${SPECS}.list`, [spec('r', 'Router'), spec('o', 'openAI')]),
                }),
                above({}, [CUSTOM]),
              ],
              as: at(withoutGateway(at(SPEC_YAML, CUSTOM)), `${SPECS}.list`, [
                spec('r', 'Router'),
                spec('o', 'openAI'),
              ]),
            },
            {
              change: 'endpoints.custom recreated by a profile after Base tombstones it',
              layers: [base({}, [CUSTOM]), role(write(CUSTOM, [gateway]))],
              as: SPEC_YAML,
            },
            {
              change: 'endpoints.custom recreated by the layer that tombstones it',
              layers: [role(write(CUSTOM, [gateway]), [CUSTOM])],
              as: SPEC_YAML,
            },
            {
              change: 'endpoints.custom a lower profile tombstones, recreated by a higher profile',
              layers: [role({}, [CUSTOM]), above(write(CUSTOM, [gateway]))],
              as: SPEC_YAML,
            },
            {
              change: 'tombstone of endpoints',
              layers: [role({}, ['endpoints'])],
              as: withoutGateway(at(SPEC_YAML, 'endpoints')),
            },
            {
              change: "Base's tombstone of endpoints, unset by the profile above",
              layers: [base({}, ['endpoints']), role()],
              as: withoutGateway(at(SPEC_YAML, 'endpoints')),
            },
            {
              change: 'endpoints.custom recreated by a profile after Base tombstones endpoints',
              layers: [base({}, ['endpoints']), role(write(CUSTOM, [gateway]))],
              as: at(at(SPEC_YAML, 'endpoints'), CUSTOM, [gateway]),
            },
            {
              change:
                'endpoints.custom recreated by a higher profile after a lower one tombstones endpoints',
              layers: [role({}, ['endpoints']), above(write(CUSTOM, [gateway]))],
              as: at(at(SPEC_YAML, 'endpoints'), CUSTOM, [gateway]),
            },
            {
              change: 'switch off: tombstone of endpoints.custom',
              layers: [role({}, [CUSTOM])],
              rederiveEndpoints: false,
              as: withoutGateway(at(SPEC_YAML, CUSTOM)),
            },
            ...builtInSpecCells,
          ].map(onSpecs),
          /**
           * Where no spec is left, none is served and the controls follow, as for tenant
           * scoping: startup derives them from librechat.yaml's list before it skips specs, so
           * these compare with librechat.yaml left without the specs startup would skip.
           */
          {
            change: 'tombstone of endpoints.custom, leaving no spec',
            yaml: GATEWAY_SPECS,
            layers: [role({}, [CUSTOM])],
            as: at(at(GATEWAY_SPECS, CUSTOM), SPECS),
          },
          {
            change: "Base's tombstone of endpoints, leaving no spec",
            yaml: GATEWAY_SPECS,
            layers: [base({}, ['endpoints']), role()],
            as: at(at(GATEWAY_SPECS, 'endpoints'), SPECS),
          },
          {
            change:
              'endpoints.custom Base tombstones, recreated by a profile: the spec served again',
            yaml: GATEWAY_SPECS,
            layers: [base({}, [CUSTOM]), role(write(CUSTOM, [gateway]))],
            as: GATEWAY_SPECS,
          },
        ],
      ],
    ];

    describe.each(matrix)('%s', (_output, probe, cells) => {
      it.each(cells.map((cell): [string, Cell] => [cell.change, cell]))(
        '%s',
        async (_change, cell) => {
          const read = async (yaml: Yaml, layers: Layer[]) =>
            probe(
              await serviceOver(yaml, layers, {
                rederiveEndpoints: cell.rederiveEndpoints ?? true,
              }).getAppConfig({ role: 'USER', tenantId: cell.tenantId }),
            );
          const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
          const served = await read(cell.yaml ?? YAML, cell.layers);
          const expected = cell.as ? await read(cell.as, []) : cell.expected;
          warn.mockRestore();

          expect(served).toEqual(expected);
        },
      );
    });
  });
});
