import { getConfigDefaults, resolveMediaConfig } from 'librechat-data-provider';
import { loadMediaConfig, AppService } from './service';
import { loadDefaultInterface } from './interface';

describe('media effective configuration', () => {
  it('preserves absence in effective config and permission intent', async () => {
    expect(loadMediaConfig({})).toBeUndefined();
    const interfaceConfig = await loadDefaultInterface({
      config: {},
      configDefaults: getConfigDefaults(),
    });
    expect(interfaceConfig?.media).toBeUndefined();
  });

  it('resolves nested defaults after effective config assembly', async () => {
    const appConfig = await AppService({
      config: { media: { enabled: false, worker: { tickMs: 2_000 } } },
    });
    expect(appConfig.media?.enabled).toBe(false);
    expect(appConfig.media?.worker.tickMs).toBe(2_000);
    expect(appConfig.media?.worker.leaseMs).toBe(60_000);
    expect(appConfig.media?.integrations).toEqual([]);
  });

  it('rejects invalid effective media policy instead of stripping unknown fields', () => {
    expect(() => loadMediaConfig({ media: { enabled: true } })).toThrow();
    expect(() =>
      loadMediaConfig({ media: { worker: { leaseMs: 1_000, renewEveryMs: 2_000 } } }),
    ).toThrow();
  });

  it('retains only explicit media permission intent independently of runtime enablement', async () => {
    const interfaceConfig = await loadDefaultInterface({
      config: { interface: { media: { use: true, create: false } }, media: resolveMediaConfig() },
      configDefaults: getConfigDefaults(),
    });
    expect(interfaceConfig?.media).toEqual({ use: true, create: false });
  });
});
