import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { createDeploymentConfigService } from './lifecycle';
import { createConfigGenerationTracker } from './reload';

function appConfig(config: TCustomConfig): AppConfig {
  return { config, availableTools: {}, endpoints: config.endpoints } as AppConfig;
}

describe('createDeploymentConfigService', () => {
  it('bootstraps before startup, then pins restart-only settings and uses the last-good timeout', async () => {
    const source: TCustomConfig = {
      version: '1.0',
      memory: { disabled: false },
      configReload: { remoteTimeoutMs: 12_000 },
    };
    const candidate: TCustomConfig = {
      version: '2.0',
      memory: { disabled: true },
      configReload: { remoteTimeoutMs: 12_000 },
    };
    const loadCustomConfig = jest
      .fn()
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(candidate);
    const buildBaseConfig = jest.fn(async (config: TCustomConfig) => appConfig(config));
    const bootstrap = jest.fn().mockResolvedValue(undefined);
    const generation = {
      ...createConfigGenerationTracker(),
      distributed: true,
      bootstrap,
      check: jest.fn().mockResolvedValue(undefined),
    };
    const store = new Map<string, unknown>();
    const service = createDeploymentConfigService({
      loadCustomConfig,
      buildBaseConfig,
      generation,
      configService: {
        setCachedTools: jest.fn().mockResolvedValue(undefined),
        getCache: () => ({
          get: async (key: string) => store.get(key),
          set: async (key: string, value: unknown) => {
            store.set(key, value);
          },
          delete: async (key: string) => store.delete(key),
        }),
        cacheKeys: { APP_CONFIG: 'APP_CONFIG' },
        getApplicableConfigs: async () => [],
        getUserPrincipals: async () => [],
      },
    });

    await service.getAppConfig({ baseOnly: true });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap.mock.invocationCallOrder[0]).toBeLessThan(
      loadCustomConfig.mock.invocationCallOrder[0],
    );
    await service.clearAppConfigCache();
    const base = await service.getAppConfig({ baseOnly: true });
    expect(loadCustomConfig).toHaveBeenNthCalledWith(1, true, {
      mode: 'startup',
      remoteTimeoutMs: undefined,
    });
    expect(loadCustomConfig).toHaveBeenNthCalledWith(2, false, {
      mode: 'reload',
      remoteTimeoutMs: 12_000,
    });
    expect(base.config?.memory?.disabled).toBe(false);
    expect(base.config?.version).toBe('1.0');
    expect(buildBaseConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ memory: { disabled: false } }),
    );
  });
});
