import { logger, AppService } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { applyLoadedConfig, recordLoadedConfig, applyStackTraceLimit } from './runtime';
import { getConfigDigest, resetConfigDigestForTests } from '~/telemetry/digest';
import { createCustomConfigLoader } from './loader';
import { createAppConfigService } from './service';

function frameCount(depth: number): number {
  const recurse = (remaining: number): Error =>
    remaining === 0 ? new Error('deep') : recurse(remaining - 1);
  return (recurse(depth).stack ?? '').split('\n').filter((line) => line.includes(' at ')).length;
}

describe('applyStackTraceLimit', () => {
  const processDefault = Error.stackTraceLimit;

  afterEach(() => {
    applyStackTraceLimit(undefined);
  });

  it('leaves the process default alone when no limit is configured', () => {
    applyStackTraceLimit(undefined);

    expect(Error.stackTraceLimit).toBe(processDefault);
  });

  it('records deeper stacks once a limit is set and restores the default when it is removed', () => {
    applyStackTraceLimit(60);

    expect(Error.stackTraceLimit).toBe(60);
    expect(frameCount(80)).toBe(60);

    applyStackTraceLimit(undefined);

    expect(Error.stackTraceLimit).toBe(processDefault);
  });
});

describe('applyLoadedConfig', () => {
  const originalConfigPath = process.env.CONFIG_PATH;
  const processDefault = Error.stackTraceLimit;

  afterEach(() => {
    applyStackTraceLimit(undefined);
    resetConfigDigestForTests();
    jest.restoreAllMocks();
    if (originalConfigPath === undefined) {
      delete process.env.CONFIG_PATH;
    } else {
      process.env.CONFIG_PATH = originalConfigPath;
    }
  });

  function createRuntime() {
    process.env.CONFIG_PATH = '/virtual/librechat.yaml';
    let text = 'version: 1.3.18\ntelemetry:\n  stackTraceLimit: 25\n';
    const load = createCustomConfigLoader({
      loadLocal: () => text,
      defaultConfigPath: '/virtual/librechat.yaml',
      redactConfig: (value: TCustomConfig) => value,
      onLoad: recordLoadedConfig,
    });
    const stored = new Map<string, unknown>();
    const cache = {
      get: async (key: string) => stored.get(key),
      set: jest.fn(async (key: string, value: unknown) => {
        stored.set(key, value);
      }),
      delete: async (key: string) => stored.delete(key),
    };
    const formatTools = jest.fn(() => ({}));
    const buildConfig = jest.fn(AppService);
    const setCachedTools = jest.fn(async () => {});
    const service = createAppConfigService({
      loadBaseConfig: async (mode) => {
        const config = (await load(false, { mode })) ?? {};
        const systemTools = formatTools();
        return buildConfig({ config, systemTools });
      },
      onBaseConfigPublished: applyLoadedConfig,
      setCachedTools,
      getCache: () => cache,
      cacheKeys: { APP_CONFIG: 'app_config' },
      getApplicableConfigs: async () => [],
      getUserPrincipals: async () => [],
    });
    return {
      ...service,
      load,
      cache,
      formatTools,
      buildConfig,
      setCachedTools,
      setText: (value: string) => {
        text = value;
      },
    };
  }

  it('does not change runtime settings when the file is only parsed', async () => {
    const runtime = createRuntime();

    await runtime.load(false);

    expect(Error.stackTraceLimit).toBe(processDefault);
    expect(getConfigDigest()).toBeUndefined();
  });

  it('applies telemetry settings on publication and restores defaults when the key is removed', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => logger);
    const runtime = createRuntime();

    await runtime.getAppConfig({ baseOnly: true });
    const first = getConfigDigest();

    expect(Error.stackTraceLimit).toBe(25);
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    runtime.setText('version: 1.3.18\n');
    await expect(runtime.reloadBaseConfig()).resolves.toEqual({ ok: true });

    expect(Error.stackTraceLimit).toBe(processDefault);
    expect(getConfigDigest()).toMatch(/^[0-9a-f]{12}$/);
    expect(getConfigDigest()).not.toBe(first);
  });

  it.each(['validation', 'tools scan', 'AppService', 'tool cache', 'base cache'])(
    'keeps the last good digest and limit when %s fails',
    async (stage) => {
      jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const runtime = createRuntime();
      const lastGood = await runtime.getAppConfig({ baseOnly: true });
      const digest = getConfigDigest();
      runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 60\n');
      const failure = new Error('publication failed');
      if (stage === 'validation') {
        runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 0\n');
      } else if (stage === 'tools scan') {
        runtime.formatTools.mockImplementationOnce(() => {
          throw failure;
        });
      } else if (stage === 'AppService') {
        runtime.buildConfig.mockRejectedValueOnce(failure);
      } else if (stage === 'tool cache') {
        runtime.setCachedTools.mockRejectedValueOnce(failure);
      } else {
        runtime.cache.set.mockRejectedValueOnce(failure);
      }

      await expect(runtime.reloadBaseConfig()).resolves.toMatchObject({ ok: false });

      expect(await runtime.getAppConfig({ baseOnly: true })).toBe(lastGood);
      expect(getConfigDigest()).toBe(digest);
      expect(Error.stackTraceLimit).toBe(25);

      runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 40\n');
      await expect(runtime.reloadBaseConfig()).resolves.toEqual({ ok: true });
      expect(Error.stackTraceLimit).toBe(40);
      expect(getConfigDigest()).not.toBe(digest);
    },
  );

  it('does not apply a config overtaken by a clear during publication', async () => {
    const runtime = createRuntime();
    await runtime.getAppConfig({ baseOnly: true });
    const digest = getConfigDigest();
    runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 60\n');
    runtime.cache.set.mockImplementationOnce(async () => {
      expect(Error.stackTraceLimit).toBe(25);
      expect(getConfigDigest()).toBe(digest);
      await runtime.clearAppConfigCache();
    });

    await runtime.reloadBaseConfig();

    expect(Error.stackTraceLimit).toBe(25);
    expect(getConfigDigest()).toBe(digest);

    runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 40\n');
    await runtime.reloadBaseConfig();
    expect(Error.stackTraceLimit).toBe(40);
    expect(getConfigDigest()).not.toBe(digest);
  });
});
