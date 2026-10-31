import { Keyv } from 'keyv';
import KeyvRedis from '@keyv/redis';
import { createClient } from '@redis/client';
import { PrincipalType } from 'librechat-data-provider';
import { logger, AppService } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { AppConfigServiceDeps } from './service';
import { applyLoadedConfig, recordLoadedConfig, applyStackTraceLimit } from './runtime';
import { getConfigDigest, resetConfigDigestForTests } from '~/telemetry/digest';
import { startRespServer } from '~/cache/__tests__/resp.helper';
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

  function createRuntime(
    baseCache?: ReturnType<AppConfigServiceDeps['getCache']>,
    getApplicableConfigs: AppConfigServiceDeps['getApplicableConfigs'] = async () => [],
  ) {
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
      get: jest.fn(async (key: string) => stored.get(key)),
      set: jest.fn(async (key: string, value: unknown): Promise<boolean | void> => {
        stored.set(key, value);
      }),
      delete: async (key: string) => stored.delete(key),
    };
    const formatTools = jest.fn(() => ({}));
    const buildConfig = jest.fn(AppService);
    const setCachedTools = jest.fn(async (): Promise<boolean | void> => {});
    const service = createAppConfigService({
      loadBaseConfig: async (mode) => {
        const config = (await load(false, { mode })) ?? {};
        const systemTools = formatTools();
        return buildConfig({ config, systemTools });
      },
      onBaseConfigPublished: applyLoadedConfig,
      setCachedTools,
      getCache: () => baseCache ?? cache,
      cacheKeys: { APP_CONFIG: 'app_config' },
      getApplicableConfigs,
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

  it('initializes local runtime settings before serving a serialized shared base cache', async () => {
    const publisher = createRuntime();
    const published = await publisher.getAppConfig({ baseOnly: true });
    const digest = getConfigDigest();
    const cached = JSON.parse(JSON.stringify(published));
    applyStackTraceLimit(undefined);
    resetConfigDigestForTests();

    const restarted = createRuntime();
    restarted.cache.get.mockResolvedValue(cached);
    const local = await restarted.getAppConfig({ baseOnly: true });

    expect(restarted.buildConfig).toHaveBeenCalledTimes(1);
    expect(local).not.toBe(cached);
    expect(Error.stackTraceLimit).toBe(25);
    expect(getConfigDigest()).toBe(digest);

    restarted.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 60\n');
    restarted.buildConfig.mockRejectedValueOnce(new Error('reload failed'));
    await expect(restarted.reloadBaseConfig()).resolves.toMatchObject({ ok: false });
    expect(Error.stackTraceLimit).toBe(25);
    expect(getConfigDigest()).toBe(digest);
  });

  it('keeps local YAML and runtime identity when another process replaces the shared base', async () => {
    const runtime = createRuntime();
    const local = await runtime.getAppConfig({ baseOnly: true });
    const digest = getConfigDigest();
    runtime.cache.get.mockResolvedValue({ config: { telemetry: { stackTraceLimit: 60 } } });

    expect(await runtime.getAppConfig({ baseOnly: true })).toBe(local);
    expect(Error.stackTraceLimit).toBe(25);
    expect(getConfigDigest()).toBe(digest);
    expect(runtime.buildConfig).toHaveBeenCalledTimes(1);

    runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 40\n');
    await runtime.clearAppConfigCache();
    const reloaded = await runtime.getAppConfig({ baseOnly: true });
    expect(reloaded.config.telemetry?.stackTraceLimit).toBe(40);
    expect(Error.stackTraceLimit).toBe(40);
    expect(getConfigDigest()).not.toBe(digest);
  });

  it('partitions serialized merged caches by local base and reuses identical bases', async () => {
    const values = new Map<string, string>();
    const cache = {
      get: async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : undefined;
      },
      set: async (key: string, value: unknown) => {
        values.set(key, JSON.stringify(value));
      },
      delete: async (key: string) => values.delete(key),
    };
    const first = createRuntime(cache);
    first.setText(
      'version: 1.3.18\ntelemetry:\n  stackTraceLimit: 25\nmemory:\n  disabled: true\n',
    );
    await first.getAppConfig({ baseOnly: true });
    const firstDigest = getConfigDigest();
    const second = createRuntime(cache);
    second.setText(
      'version: 1.3.18\ntelemetry:\n  stackTraceLimit: 60\nmemory:\n  disabled: false\n',
    );
    await second.getAppConfig({ role: 'USER' });

    const local = await first.getAppConfig({ role: 'USER' });
    expect(local.config.telemetry?.stackTraceLimit).toBe(25);
    expect(local.memory?.disabled).toBe(true);
    expect([...values.keys()].filter((key) => key.startsWith('_OVERRIDE_'))).toHaveLength(2);

    const identical = createRuntime(cache);
    identical.setText(
      'version: 1.3.18\ntelemetry:\n  stackTraceLimit: 25\nmemory:\n  disabled: true\n',
    );
    expect((await identical.getAppConfig({ role: 'USER' })).memory?.disabled).toBe(true);
    expect(getConfigDigest()).toBe(firstDigest);
    expect([...values.keys()].filter((key) => key.startsWith('_OVERRIDE_'))).toHaveLength(2);

    identical.setText(
      'version: 1.3.18\ntelemetry:\n  stackTraceLimit: 40\nmemory:\n  disabled: false\n',
    );
    await identical.clearAppConfigCache();
    expect((await identical.getAppConfig({ role: 'USER' })).memory?.disabled).toBe(false);
    expect(Error.stackTraceLimit).toBe(40);
    expect(getConfigDigest()).not.toBe(firstDigest);
    expect([...values.keys()].filter((key) => key.startsWith('_OVERRIDE_'))).toHaveLength(3);
  });

  it('serves database restrictions uncached through Redis write and connection failures', async () => {
    jest.spyOn(logger, 'warn').mockReturnValue(logger);
    const server = await startRespServer();
    const client = createClient({
      url: server.url,
      socket: { reconnectStrategy: false, connectTimeout: 100 },
    });
    const adapter = new KeyvRedis(client, { throwOnErrors: true });
    const cache = new Keyv({ store: adapter, namespace: 'APP_CONFIG', throwOnErrors: true });
    cache.on('error', () => undefined);
    const getApplicableConfigs = jest.fn(
      async (): ReturnType<AppConfigServiceDeps['getApplicableConfigs']> => [
        {
          principalType: PrincipalType.ROLE,
          principalId: 'USER',
          priority: 10,
          overrides: { interface: { modelSelect: false } },
        },
      ],
    );
    try {
      await client.connect();
      const runtime = createRuntime(
        {
          get: (key) => cache.get(key),
          set: (key, value) => cache.set(key, value),
          delete: (key) => cache.delete(key),
        },
        getApplicableConfigs,
      );
      await runtime.getAppConfig({ baseOnly: true });
      const digest = getConfigDigest();
      server.readonly = true;

      expect(
        (await runtime.getAppConfig({ role: 'USER', failClosed: true })).interfaceConfig
          ?.modelSelect,
      ).toBe(false);
      await server.close();
      client.destroy();
      expect(
        (await runtime.getAppConfig({ role: 'USER', failClosed: true })).interfaceConfig
          ?.modelSelect,
      ).toBe(false);

      expect(getApplicableConfigs).toHaveBeenCalledTimes(2);
      expect(Error.stackTraceLimit).toBe(25);
      expect(getConfigDigest()).toBe(digest);
    } finally {
      if (client.isOpen) client.destroy();
      await server.close();
    }
  });

  it('keeps last-good telemetry when the real Redis adapter rejects SET, then retries', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const server = await startRespServer();
    const client = createClient({ url: server.url, socket: { reconnectStrategy: false } });
    const adapter = new KeyvRedis(client, { throwOnErrors: true });
    const cache = new Keyv({ store: adapter, namespace: 'APP_CONFIG', throwOnErrors: true });
    cache.on('error', () => undefined);
    try {
      await client.connect();
      const runtime = createRuntime({
        get: (key) => cache.get(key),
        set: (key, value) => cache.set(key, value),
        delete: (key) => cache.delete(key),
      });
      const lastGood = await runtime.getAppConfig({ baseOnly: true });
      const digest = getConfigDigest();
      runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 60\n');
      server.readonly = true;

      await expect(runtime.reloadBaseConfig()).resolves.toMatchObject({ ok: false });
      expect(await runtime.getAppConfig({ baseOnly: true })).toBe(lastGood);
      expect(Error.stackTraceLimit).toBe(25);
      expect(getConfigDigest()).toBe(digest);

      server.readonly = false;
      await expect(runtime.reloadBaseConfig()).resolves.toEqual({ ok: true });
      expect(Error.stackTraceLimit).toBe(60);
      expect(getConfigDigest()).not.toBe(digest);
    } finally {
      client.destroy();
      await server.close();
    }
  });

  it.each([
    'validation',
    'tools scan',
    'AppService',
    'tool cache',
    'base cache',
    'tool cache refusal',
    'base cache refusal',
  ])('keeps the last good digest and limit when %s fails', async (stage) => {
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
    } else if (stage === 'base cache') {
      runtime.cache.set.mockRejectedValueOnce(failure);
    } else if (stage === 'tool cache refusal') {
      runtime.setCachedTools.mockResolvedValueOnce(false);
    } else {
      runtime.cache.set.mockResolvedValueOnce(false);
    }

    await expect(runtime.reloadBaseConfig()).resolves.toMatchObject({ ok: false });

    expect(await runtime.getAppConfig({ baseOnly: true })).toBe(lastGood);
    expect(getConfigDigest()).toBe(digest);
    expect(Error.stackTraceLimit).toBe(25);

    runtime.setText('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 40\n');
    await expect(runtime.reloadBaseConfig()).resolves.toEqual({ ok: true });
    expect(Error.stackTraceLimit).toBe(40);
    expect(getConfigDigest()).not.toBe(digest);
  });

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
