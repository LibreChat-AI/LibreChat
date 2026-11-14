import { Keyv } from 'keyv';
import { CacheKeys, FileSources, PrincipalType } from 'librechat-data-provider';
import { getTenantId, BASE_CONFIG_PRINCIPAL_ID } from '@librechat/data-schemas';
import type { AppConfig, ConfigOverrideLayer } from '@librechat/data-schemas';
import type { AppConfigServiceDeps } from './service';
import { standardCache } from '~/cache/cacheFactory';
import { ConfigMemoryStore } from '~/cache/config';
import { createAppConfigService } from './service';

const maxBytes = 1024 * 1024;
const padding = 'x'.repeat(70 * 1024);

function createFixture(layers: ConfigOverrideLayer[] = []) {
  const cache = standardCache(CacheKeys.APP_CONFIG);
  const base: AppConfig = {
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    config: {
      version: '1.3.18',
      configCache: { maxBytes, maxEntries: 32 },
      interface: { customWelcome: padding },
    },
    interfaceConfig: { customWelcome: padding },
  };
  const getApplicableConfigs = jest.fn(
    async (_principals?: Parameters<AppConfigServiceDeps['getApplicableConfigs']>[0]) => layers,
  );
  const loadBaseConfig = jest.fn(async () => structuredClone(base));
  const deps: AppConfigServiceDeps = {
    cacheKeys: CacheKeys,
    getCache: () => ({
      get: (key) => cache.get(key),
      set: (key, value, ttl) => cache.set(key, value, ttl),
      delete: (key) => cache.delete(key),
      opts: { store: memoryStore(cache) },
    }),
    loadBaseConfig,
    setCachedTools: async () => undefined,
    getUserPrincipals: async ({ userId, role }) => [
      { principalType: PrincipalType.ROLE, principalId: role ?? 'USER' },
      { principalType: PrincipalType.USER, principalId: userId.toString() },
      { principalType: PrincipalType.GROUP, principalId: 'shared-group' },
    ],
    getApplicableConfigs,
  };
  return {
    ...createAppConfigService(deps),
    cache,
    deps,
    base,
    getApplicableConfigs,
    loadBaseConfig,
  };
}

function layer(principalType: PrincipalType, principalId: string): ConfigOverrideLayer {
  return {
    principalType,
    principalId,
    priority: 10,
    overrides: { interface: { modelSelect: false } },
  };
}

function memoryStore(cache: Keyv): ConfigMemoryStore | Map<string, string> {
  const store = cache.opts.store;
  if (!(store instanceof Map) && !(store instanceof ConfigMemoryStore)) {
    throw new Error('Expected the serialized memory store');
  }
  return store;
}

function retained(cache: Keyv) {
  const store = memoryStore(cache);
  const keys = [...store.keys()];
  return {
    entries: keys.length,
    bytes: keys.reduce((sum, key) => {
      const value = store.get(key);
      return sum + 2 * (key.length + (typeof value === 'string' ? value.length : 0));
    }, 0),
  };
}

describe('configuration cache retention through the production service and serialized Keyv store', () => {
  afterEach(async () => {
    await standardCache(CacheKeys.APP_CONFIG).clear();
    jest.useRealTimers();
  });

  it.each([
    ['base', [layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID)]],
    [
      'role',
      [layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID), layer(PrincipalType.ROLE, 'USER')],
    ],
    [
      'group',
      [
        layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID),
        layer(PrincipalType.GROUP, 'shared-group'),
      ],
    ],
  ])('bounds full merged configs with an active %s layer', async (_name, layers) => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    const fixture = createFixture(layers);
    const before = process.memoryUsage().heapUsed;
    for (let index = 0; index < 2000; index++) {
      const config = await fixture.getAppConfig({ role: 'USER', userId: `user-${index}` });
      expect(config.interfaceConfig?.modelSelect).toBe(false);
    }
    const live = retained(fixture.cache);
    console.info('config-cache-retention', {
      scenario: _name,
      users: 2000,
      ...live,
      heapDelta: process.memoryUsage().heapUsed - before,
      queries: fixture.getApplicableConfigs.mock.calls.length,
    });
    expect(live.bytes).toBeLessThanOrEqual(maxBytes);
    expect(live.entries).toBeLessThanOrEqual(32);
    expect(fixture.loadBaseConfig).toHaveBeenCalledTimes(1);
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(2000);
    await jest.advanceTimersByTimeAsync(fixture.overrideCacheTtl + 1);
    expect(retained(fixture.cache).entries).toBeLessThanOrEqual(1);
  });

  it('reclaims cold sentinels without rereading their principal keys', async () => {
    jest.useFakeTimers({ now: 1_800_000_000_000 });
    const fixture = createFixture();
    for (let index = 0; index < 100; index++) {
      await fixture.getAppConfig({ role: 'USER', userId: `user-${index}` });
    }
    expect(retained(fixture.cache).entries).toBeLessThanOrEqual(32);
    await jest.advanceTimersByTimeAsync(fixture.overrideCacheTtl + 1);
    expect(
      [...memoryStore(fixture.cache).keys()].every((key) => !key.includes('_OVERRIDE_:')),
    ).toBe(true);
  });

  it('bounds concurrent misses with distinct user overrides without sharing their results', async () => {
    const fixture = createFixture();
    fixture.getApplicableConfigs.mockImplementation(async (principals) => {
      const user = principals?.find((principal) => principal.principalType === PrincipalType.USER);
      if (!user?.principalId) throw new Error('Expected a user principal');
      return [
        layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID),
        {
          principalType: PrincipalType.USER,
          principalId: user.principalId,
          priority: 20,
          overrides: { interface: { customWelcome: `${user.principalId}:${padding}` } },
        },
      ];
    });
    const results = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        fixture.getAppConfig({ role: 'USER', userId: `user-${index}` }),
      ),
    );
    for (const [index, result] of results.entries()) {
      expect(result.interfaceConfig?.customWelcome).toBe(`user-${index}:${padding}`);
    }
    expect(new Set(results).size).toBe(64);
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(64);
    expect(fixture.loadBaseConfig).toHaveBeenCalledTimes(1);
    expect(retained(fixture.cache).bytes).toBeLessThanOrEqual(maxBytes);
    const calls = fixture.getApplicableConfigs.mock.calls.length;
    await fixture.getAppConfig({ role: 'USER', userId: 'user-63' });
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(calls);
  });

  it('applies deployment limits again on reload, never from DB overrides', async () => {
    const fixture = createFixture([
      {
        ...layer(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID),
        overrides: { configCache: { maxEntries: 1 } },
      },
    ]);
    await fixture.getAppConfig({ userId: 'a' });
    await fixture.getAppConfig({ userId: 'b' });
    expect(retained(fixture.cache).entries).toBe(3);
    fixture.base.config!.configCache = { maxEntries: 1, maxBytes };
    await fixture.reloadBaseConfig();
    expect(retained(fixture.cache).entries).toBe(1);
  });

  it('preserves tenant/user isolation, warm hits, and independent returned objects', async () => {
    const fixture = createFixture();
    fixture.getApplicableConfigs.mockImplementation(async () => [
      {
        principalType: PrincipalType.USER,
        principalId: 'actor',
        priority: 20,
        overrides: { interface: { customWelcome: `${getTenantId()}-private` } },
      },
    ]);
    const options = { role: 'USER', userId: 'actor', tenantId: 'tenant-a' };
    const first = await fixture.getAppConfig(options);
    first.interfaceConfig!.customWelcome = 'mutated';
    const second = await fixture.getAppConfig(options);
    expect(second.interfaceConfig?.customWelcome).toBe('tenant-a-private');
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(1);
    const other = await fixture.getAppConfig({ ...options, tenantId: 'tenant-b' });
    expect(other.interfaceConfig?.customWelcome).toBe('tenant-b-private');
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(2);
    await fixture.clearOverrideCache('tenant-a');
    await fixture.getAppConfig({ ...options, tenantId: 'tenant-b' });
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(2);
    await fixture.getAppConfig(options);
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(3);
    await fixture.clearAppConfigCache();
    fixture.base.config!.version = 'reloaded';
    await fixture.reloadBaseConfig();
    await fixture.getAppConfig(options);
    expect(fixture.getApplicableConfigs).toHaveBeenCalledTimes(4);
  });
});
