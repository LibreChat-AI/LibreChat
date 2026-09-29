import path from 'path';
import { logger } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { createCustomConfigLoader, ConfigReloadError } from './loader';
import { loadYaml } from '~/utils/yaml';

const fixture = (name: string) => path.join(__dirname, '__fixtures__', 'theme', `${name}.yaml`);

const raw = (name: string) => loadYaml(fixture(name)) as TCustomConfig;

const createLoader = () =>
  createCustomConfigLoader({
    loadLocal: loadYaml,
    defaultConfigPath: fixture('valid'),
    redactConfig: (config: TCustomConfig) => config,
  });

const warnings = (spy: jest.SpyInstance): string =>
  spy.mock.calls.map(([message]) => String(message)).join('\n');

describe('createCustomConfigLoader interface.theme', () => {
  const originalConfigPath = process.env.CONFIG_PATH;
  let warn: jest.SpyInstance;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    jest.spyOn(logger, 'info').mockImplementation(() => logger);
    exit = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalConfigPath === undefined) {
      delete process.env.CONFIG_PATH;
    } else {
      process.env.CONFIG_PATH = originalConfigPath;
    }
  });

  const load = async (name: string, mode: 'startup' | 'reload' = 'startup') => {
    process.env.CONFIG_PATH = fixture(name);
    return createLoader()(false, { mode });
  };

  it('returns a valid theme exactly as written, without warnings', async () => {
    const config = await load('valid');

    expect(config?.interface?.theme).toEqual(raw('valid').interface?.theme);
    expect(config?.interface?.modelSelect).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('keeps a theme naming a color token this version does not know, without that token', async () => {
    const config = await load('unknown-token');

    expect(exit).not.toHaveBeenCalled();
    expect(config?.interface?.theme).toEqual({
      version: 1,
      name: 'acme',
      modes: { light: { colors: { 'rgb-surface-primary': '240 244 255' } } },
    });
    expect(config?.interface?.modelSelect).toBe(true);
    expect(config?.cache).toBe(true);
    expect(warnings(warn)).toContain(
      'interface.theme.modes.light.colors.rgb-surfce-secondary: Unknown light color token ignored: rgb-surfce-secondary',
    );
    expect(warnings(warn)).toContain(
      'interface.theme.modes.light.colors.surface-tertiary: Unknown light color token ignored: surface-tertiary',
    );
    expect(warnings(warn)).not.toContain('the default theme applies instead');
  });

  it('still drops a theme whose unknown color token has an invalid value or name', async () => {
    const config = await load('unknown-token-invalid');

    expect(exit).not.toHaveBeenCalled();
    expect(config?.interface).not.toHaveProperty('theme');
    expect(config?.interface?.modelSelect).toBe(true);
    const logged = warnings(warn);
    expect(logged).toContain(
      'interface.theme.modes.light.colors.rgb-future-role: Invalid RGB value for rgb-future-role: red',
    );
    expect(logged).toContain(
      'interface.theme.modes.dark.colors.Surface Tertiary: Unknown color token: Surface Tertiary',
    );
    expect(logged).toContain('the default theme applies instead');
  });

  it('reports every bad value with its path and drops the theme', async () => {
    const config = await load('bad-value');

    expect(exit).not.toHaveBeenCalled();
    expect(config?.interface).not.toHaveProperty('theme');
    const logged = warnings(warn);
    expect(logged).toContain(
      'interface.theme.modes.dark.colors.rgb-surface-primary: Invalid RGB value for rgb-surface-primary: 300 16 32',
    );
    expect(logged).toContain(
      'interface.theme.modes.dark.appearance.controlRadius: Invalid appearance value for controlRadius: 4 pixels',
    );
  });

  it('drops a theme that is neither a name nor a definition', async () => {
    const config = await load('malformed');

    expect(exit).not.toHaveBeenCalled();
    expect(config?.interface).not.toHaveProperty('theme');
    expect(config?.interface?.modelSelect).toBe(true);
    expect(warnings(warn)).toContain(
      'interface.theme: Expected a bundled theme name or an inline theme definition',
    );
  });

  it('drops a value the client reads but the config schema rejects, citing the schema path', async () => {
    const config = await load('spacing');

    expect(exit).not.toHaveBeenCalled();
    expect(config?.interface).not.toHaveProperty('theme');
    expect(warnings(warn)).toContain('interface.theme.modes.light.colors.rgb-surface-primary:');
  });

  it('drops a bundled theme name that does not exist', async () => {
    const config = await load('unknown-name');

    expect(exit).not.toHaveBeenCalled();
    expect(config?.interface).not.toHaveProperty('theme');
    expect(config?.interface?.modelSelect).toBe(true);
    expect(warnings(warn)).toContain(
      'interface.theme: Unknown bundled theme "clickhous", expected one of: librechat, clickhouse',
    );
  });

  it('keeps a bundled theme name', async () => {
    const config = await load('bundled');

    expect(config?.interface?.theme).toBe('clickhouse');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a theme whose only problem is an appearance token this version ignores', async () => {
    const config = await load('unknown-appearance');

    expect(config?.interface?.theme).toEqual(raw('unknown-appearance').interface?.theme);
    expect(warnings(warn)).toContain(
      'interface.theme.modes.light.appearance.futureSpacing: Unknown light appearance token ignored: futureSpacing',
    );
    expect(warnings(warn)).not.toContain('the default theme applies instead');
  });

  it('still exits at startup when something other than the theme is invalid', async () => {
    await expect(load('unrelated-error')).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(warnings(warn)).toContain('interface.theme.modes.light.colors.rgb-surfce-primary');
  });

  describe('reload mode', () => {
    it('applies the same fallback instead of rejecting the reload', async () => {
      const config = await load('bad-value', 'reload');

      expect(config?.interface).not.toHaveProperty('theme');
      expect(config?.interface?.modelSelect).toBe(true);
      expect(warnings(warn)).toContain(
        'interface.theme.modes.dark.colors.rgb-surface-primary: Invalid RGB value',
      );
    });

    it('returns a valid theme unchanged', async () => {
      const config = await load('valid', 'reload');

      expect(config?.interface?.theme).toEqual(raw('valid').interface?.theme);
      expect(warn).not.toHaveBeenCalled();
    });

    it('still rejects a reload whose other keys are invalid', async () => {
      await expect(load('unrelated-error', 'reload')).rejects.toBeInstanceOf(ConfigReloadError);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
