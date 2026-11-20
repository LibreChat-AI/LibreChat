import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * A mistake in `interface.theme` used to fail the whole librechat.yaml and stop the server. The
 * config loader that `/api` wires up now drops only the theme, names each problem by its path, and
 * loads everything else; a token this version does not know only warns. The mock lane serves one shared yaml, so these load their own fixtures
 * through that same loader in a child process, the way the server does at startup and on reload.
 */
test.describe.configure({ timeout: 120_000 });

const fixtures = resolve(repoRoot, 'packages/api/src/app/__fixtures__/theme');
const RESULT = '__THEME_SCENARIO_RESULT__';
/** The logger colours its console output. */
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const loadScript = `
const load = require('./server/services/Config/loadCustomConfig');
process.exit = (code) => {
  console.log('${RESULT}' + JSON.stringify({ exited: code }));
  process.reallyExit(0);
};
load(false, { mode: process.argv[1] }).then(
  (config) => {
    console.log('${RESULT}' + JSON.stringify({ interface: config && config.interface }));
    process.reallyExit(0);
  },
  (error) => {
    console.log('${RESULT}' + JSON.stringify({ rejected: error.name }));
    process.reallyExit(0);
  },
);
`;

type LoadOutcome = {
  interface?: { theme?: unknown; modelSelect?: boolean };
  exited?: number;
  rejected?: string;
};

function loadFixture(name: string, mode: 'startup' | 'reload' = 'startup') {
  process.env.CONFIG_PATH = resolve(fixtures, `${name}.yaml`);
  const result = run('node', ['-e', loadScript, mode], { cwd: resolve(repoRoot, 'api') });
  const log = result.output.replace(ANSI_COLOR, '');
  const line = log.split('\n').find((entry) => entry.startsWith(RESULT));
  if (!line) {
    throw new Error(`The loader printed no result:\n${log}`);
  }
  return { outcome: JSON.parse(line.slice(RESULT.length)) as LoadOutcome, log };
}

test.describe('interface.theme in librechat.yaml', () => {
  test.beforeEach(() => inOneProject());
  test.afterEach(() => {
    delete process.env.CONFIG_PATH;
  });

  test('a color token this version does not know is ignored and the theme still loads @scenario:yaml-theme-unknown-color-kept', () => {
    const { outcome, log } = loadFixture('unknown-token');

    expect(outcome.exited).toBeUndefined();
    expect(outcome.interface?.modelSelect).toBe(true);
    expect(outcome.interface?.theme).toEqual({
      version: 1,
      name: 'acme',
      modes: { light: { colors: { 'rgb-surface-primary': '240 244 255' } } },
    });
    expect(log).not.toContain('the default theme applies instead');
    expect(log).toContain(
      'interface.theme.modes.light.colors.rgb-surfce-secondary: Unknown light color token ignored: rgb-surfce-secondary',
    );
    expect(log).toContain(
      'interface.theme.modes.light.colors.surface-tertiary: Unknown light color token ignored: surface-tertiary',
    );
  });

  test('a bad token value is reported with its path and the theme is dropped @scenario:yaml-theme-bad-value-reported', () => {
    const { outcome, log } = loadFixture('bad-value');

    expect(outcome.exited).toBeUndefined();
    expect(outcome.interface).toEqual({ modelSelect: true });
    expect(log).toContain(
      'interface.theme.modes.dark.colors.rgb-surface-primary: Invalid RGB value for rgb-surface-primary: 300 16 32',
    );
    expect(log).toContain(
      'interface.theme.modes.dark.appearance.controlRadius: Invalid appearance value for controlRadius: 4 pixels',
    );
  });

  test('a misspelled bundled theme name falls back with a warning @scenario:yaml-theme-unknown-name-falls-back', () => {
    const { outcome, log } = loadFixture('unknown-name');

    expect(outcome.exited).toBeUndefined();
    expect(outcome.interface).toEqual({ modelSelect: true });
    expect(log).toContain(
      'interface.theme: Unknown bundled theme "clickhous", expected one of: librechat, clickhouse',
    );
    expect(loadFixture('bundled').outcome.interface?.theme).toBe('clickhouse');
  });

  test('a valid inline theme loads exactly as written @scenario:yaml-theme-valid-unchanged', () => {
    const { outcome, log } = loadFixture('valid');

    expect(outcome.interface?.theme).toEqual({
      version: 1,
      name: 'acme',
      modes: {
        light: {
          colors: { 'rgb-surface-primary': '240 244 255' },
          appearance: { controlRadius: '0.25rem' },
        },
        dark: { colors: { 'rgb-surface-primary': '12 16 32' } },
      },
      brands: { 'provider-openai': '#10a37f' },
    });
    expect(log).not.toContain('interface.theme');
  });

  test('a config reload with a broken theme applies the same fallback @scenario:yaml-theme-reload-falls-back', () => {
    const { outcome, log } = loadFixture('bad-value', 'reload');

    expect(outcome.rejected).toBeUndefined();
    expect(outcome.interface).toEqual({ modelSelect: true });
    expect(log).toContain('interface.theme.modes.dark.colors.rgb-surface-primary');
  });

  test('an invalid key outside the theme still stops startup @scenario:yaml-theme-other-errors-still-exit', () => {
    const { outcome } = loadFixture('unrelated-error');

    expect(outcome.exited).toBe(1);
    expect(loadFixture('unrelated-error', 'reload').outcome.rejected).toBe('ConfigReloadError');
  });
});
