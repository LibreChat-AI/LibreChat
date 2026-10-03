import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * `npm run test:turbo` replays a cached pass whenever a task's hash is unchanged,
 * so every file and variable a suite reads has to reach that hash, and every
 * build a suite imports has to finish before it starts. These scenarios read
 * Turbo's own dry-run plan for the checkout; nothing runs and nothing is written.
 */

type DryTask = {
  taskId: string;
  hash: string;
  dependencies: string[];
  inputs: Record<string, string>;
  resolvedTaskDefinition: { inputs: string[] };
};

const TURBO = resolve(repoRoot, 'node_modules/.bin/turbo');
const SUITES = [
  '@librechat/frontend',
  '@librechat/backend',
  '@librechat/api',
  'librechat-data-provider',
  '@librechat/data-schemas',
];

function plan(task: string, env: Record<string, string> = {}): Map<string, DryTask> {
  const base = { ...process.env };
  delete base.RUN_USAGE_LIVE_TESTS;
  const result = spawnSync(
    TURBO,
    ['run', task, '--dry=json', ...SUITES.map((name) => `--filter=${name}`)],
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

test.describe('the cached test runner', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(120_000);
  });

  test('a source a suite imports from another workspace is in its cache key @scenario:a-cross-workspace-test-import-reruns-its-suite', () => {
    const tasks = plan('test:ci');
    const api = Object.keys(get(tasks, '@librechat/api#test:ci').inputs);
    expect(api).toContain('../../client/src/components/Chat/Messages/Content/Parts/handle.ts');
    expect(api).toContain('../../client/src/components/Chat/approval/preview.ts');
    expect(api.some((file) => file.startsWith('../../client/src/hooks/'))).toBe(false);

    const backend = Object.keys(get(tasks, '@librechat/backend#test:ci').inputs);
    expect(backend).toContain('../config/migrate-orphaned-agent-files.js');
    expect(backend).toContain('../config/connect.js');
    expect(backend.some((file) => file.startsWith('utils/'))).toBe(true);
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

  test('enabling a live suite changes the cache key @scenario:enabling-a-live-suite-misses-the-cache', () => {
    const off = get(plan('test:ci'), '@librechat/backend#test:ci').hash;
    const on = get(
      plan('test:ci', { RUN_USAGE_LIVE_TESTS: '1' }),
      '@librechat/backend#test:ci',
    ).hash;
    expect(on).not.toBe(off);

    /** responses.spec.js reads its live credential from the ignored root `.env`,
     *  which may be absent here, so the resolved globs are checked as well. */
    const backend = get(plan('test:ci'), '@librechat/backend#test:ci');
    expect(backend.resolvedTaskDefinition.inputs).toContain('../.env');
    if (existsSync(resolve(repoRoot, '.env'))) {
      expect(Object.keys(backend.inputs)).toContain('../.env');
    }
  });

  test('a package build hashes its shipped assets but not its specs @scenario:a-spec-edit-keeps-the-package-build-cached', () => {
    const inputs = Object.keys(get(plan('build'), '@librechat/api#build').inputs);
    expect(inputs).toContain('openapi/agents.openapi.json');
    expect(inputs.some((file) => /\.spec\.|\.test\.|__tests__\//.test(file))).toBe(false);
    expect(inputs.some((file) => file.startsWith('src/'))).toBe(true);
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
