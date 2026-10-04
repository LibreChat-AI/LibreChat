import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * `npm run build` restores package `dist/` from Turbo's cache, so every input a
 * build bakes in has to reach its hash. `npm run test:turbo` runs the unit suites
 * in parallel but never replays a result: a suite here reads fixtures, env files
 * and source from other workspaces, so no input list could make a cached pass
 * trustworthy. With no cache to key, every caller variable is passed through. These scenarios read Turbo's own dry-run plan for the checkout;
 * nothing runs and nothing is written.
 */

type DryTask = {
  taskId: string;
  hash: string;
  dependencies: string[];
  inputs: Record<string, string>;
  resolvedTaskDefinition: { cache: boolean };
  environmentVariables: { passthrough: string[] | null };
};

const TURBO = resolve(repoRoot, 'node_modules/.bin/turbo');
const rootScripts = (
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
/** The workspaces `npm run test:turbo` selects, read from the script itself. */
const SUITES = [...rootScripts['test:turbo'].matchAll(/--filter=(\S+)/g)].map((match) => match[1]);

function plan(
  task: string,
  env: Record<string, string> = {},
  filters: string[] = SUITES,
): Map<string, DryTask> {
  const base = { ...process.env };
  delete base.VITE_ENABLE_LOGGER;
  const result = spawnSync(
    TURBO,
    ['run', task, '--dry=json', ...filters.map((name) => `--filter=${name}`)],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...base, TURBO_TELEMETRY_DISABLED: '1', ...env },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const { tasks } = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as {
    tasks: DryTask[];
  };
  return new Map(tasks.map((entry) => [entry.taskId, entry]));
}

function get(tasks: Map<string, DryTask>, id: string): DryTask {
  const entry = tasks.get(id);
  expect(entry, `${id} is in the plan`).toBeDefined();
  return entry!;
}

test.describe('the parallel test runner', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(120_000);
  });

  test('the runner covers every workspace with a test suite @scenario:test-turbo-covers-every-workspace-suite', () => {
    const everySuite = [...plan('test:ci', {}, []).keys()].filter((id) => id.endsWith('#test:ci'));
    expect(SUITES.map((name) => `${name}#test:ci`).sort()).toEqual(everySuite.sort());
  });

  test('every suite runs instead of replaying a cached result @scenario:test-turbo-always-runs-every-suite', () => {
    const tasks = plan('test:ci');
    for (const name of SUITES) {
      expect(get(tasks, `${name}#test:ci`).resolvedTaskDefinition.cache, name).toBe(false);
    }
  });

  test('each suite starts after the builds its specs import @scenario:each-suite-waits-for-the-builds-it-imports', () => {
    const tasks = plan('test:ci');
    expect(get(tasks, '@librechat/data-schemas#test:ci').dependencies).toContain(
      'librechat-data-provider#build',
    );
    expect(get(tasks, '@librechat/api#test:ci').dependencies).toEqual(
      expect.arrayContaining(['librechat-data-provider#build', '@librechat/data-schemas#build']),
    );
    expect(get(tasks, '@librechat/backend#test:ci').dependencies).toEqual(
      expect.arrayContaining([
        'librechat-data-provider#build',
        '@librechat/data-schemas#build',
        '@librechat/api#build',
      ]),
    );
    expect(get(tasks, '@librechat/frontend#test:ci').dependencies).toEqual(
      expect.arrayContaining(['librechat-data-provider#build', '@librechat/client#build']),
    );
  });

  test('every variable the caller sets reaches jest @scenario:live-suite-env-reaches-jest', () => {
    const names = [
      'RUN_USAGE_LIVE_TESTS',
      'OPENWEATHER_API_KEY',
      'MONGOMS_SYSTEM_BINARY',
      'TMPDIR',
    ];
    const tasks = plan('test:ci', Object.fromEntries(names.map((name) => [name, '/tmp/x'])));
    for (const suite of SUITES) {
      const passed = (get(tasks, `${suite}#test:ci`).environmentVariables.passthrough ?? []).map(
        (entry) => entry.slice(0, entry.indexOf('=')),
      );
      expect(passed, suite).toEqual(expect.arrayContaining(names));
    }
  });
});

test.describe('the package build cache', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(120_000);
  });

  test('a package build hashes its shipped assets but not its specs @scenario:a-spec-edit-keeps-the-package-build-cached', () => {
    const inputs = Object.keys(get(plan('build'), '@librechat/api#build').inputs);
    expect(inputs).toContain('openapi/agents.openapi.json');
    expect(inputs.some((file) => /\.spec\.|\.test\.|__tests__\//.test(file))).toBe(false);
    expect(inputs.some((file) => file.startsWith('src/'))).toBe(true);
  });

  test('the client package rebuilds when its baked logger setting changes @scenario:client-package-build-tracks-baked-env', () => {
    const off = get(plan('build', { VITE_ENABLE_LOGGER: 'false' }), '@librechat/client#build');
    const on = get(plan('build', { VITE_ENABLE_LOGGER: 'true' }), '@librechat/client#build');
    expect(on.hash).not.toBe(off.hash);
  });
});

test.describe('client coverage', () => {
  test.beforeEach(() => inOneProject());

  test('collects coverage only when the run asks for it @scenario:client-coverage-runs-only-when-requested', () => {
    const config = resolve(repoRoot, 'client/jest.config.cjs');
    const read = (coverage?: string) => {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.COVERAGE;
      if (coverage !== undefined) {
        env.COVERAGE = coverage;
      }
      const result = spawnSync(
        process.execPath,
        ['-e', `process.stdout.write(String(require(${JSON.stringify(config)}).collectCoverage))`],
        { cwd: repoRoot, encoding: 'utf8', env },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    expect(read()).toBe('false');
    expect(read('true')).toBe('true');

    const manifest = readFileSync(resolve(repoRoot, 'client/package.json'), 'utf8');
    const scripts = (JSON.parse(manifest) as { scripts: Record<string, string> }).scripts;
    expect(scripts['test:ci']).toContain('COVERAGE=true');
  });
});
