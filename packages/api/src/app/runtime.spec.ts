import { logger } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { getConfigDigest, resetConfigDigestForTests } from '~/telemetry/digest';
import { applyLoadedConfig, applyStackTraceLimit } from './runtime';
import { createCustomConfigLoader } from './loader';

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

  const load = (text: string) => {
    process.env.CONFIG_PATH = '/virtual/librechat.yaml';
    return createCustomConfigLoader({
      loadLocal: () => text,
      defaultConfigPath: '/virtual/librechat.yaml',
      redactConfig: (value: TCustomConfig) => value,
      onLoad: applyLoadedConfig,
    })(false, { mode: 'reload' });
  };

  it('applies telemetry.stackTraceLimit and records the digest each time librechat.yaml loads', async () => {
    jest.spyOn(logger, 'info').mockImplementation(() => logger);

    await load('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 25\n');
    const first = getConfigDigest();

    expect(Error.stackTraceLimit).toBe(25);
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    await load('version: 1.3.18\n');

    expect(Error.stackTraceLimit).toBe(processDefault);
    expect(getConfigDigest()).toMatch(/^[0-9a-f]{12}$/);
    expect(getConfigDigest()).not.toBe(first);
  });

  it('keeps the last good digest and limit when a reload is rejected', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);

    await load('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 30\n');
    const good = getConfigDigest();

    await expect(load('version: 1.3.18\ntelemetry:\n  stackTraceLimit: 0\n')).rejects.toThrow();

    expect(getConfigDigest()).toBe(good);
    expect(Error.stackTraceLimit).toBe(30);
  });
});
