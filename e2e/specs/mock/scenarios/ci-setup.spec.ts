import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * CI job setup: how much history a checkout fetches and which installed
 * dependency tree a job restores instead of running `npm ci`. Both scenarios
 * read the workflows as GitHub runs them; the checkout one replays the
 * configured fetch against a local repository shaped like a pull request.
 */

type Step = {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number | boolean>;
};
type Job = { 'runs-on'?: string; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

const WORKFLOWS = resolve(repoRoot, '.github/workflows');

function workflow(file: string): Workflow {
  return yaml.load(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'ci',
      GIT_AUTHOR_EMAIL: 'ci@example.com',
      GIT_COMMITTER_NAME: 'ci',
      GIT_COMMITTER_EMAIL: 'ci@example.com',
      ...env,
    },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function ok(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  expect(result.status, `git ${args.join(' ')}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

function commit(repo: string, files: Record<string, string | null>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      ok(repo, ['rm', '-q', path]);
      continue;
    }
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
    ok(repo, ['add', path]);
  }
  ok(repo, ['commit', '-q', '-m', message]);
  return ok(repo, ['rev-parse', 'HEAD']).trim();
}

/**
 * A pull request as GitHub hands it to a workflow: the base branch moved on
 * after the branch point, the head changed the ESLint config and renamed a
 * file, and `refs/pull/1/merge` is the merge commit whose first parent is the
 * event's base SHA.
 */
function pullRequestOrigin(root: string): { url: string; base: string; merge: string } {
  const origin = join(root, 'origin');
  mkdirSync(origin);
  ok(origin, ['init', '-q', '-b', 'dev']);
  const fork = commit(
    origin,
    {
      'eslint.config.mjs': "export default ['base'];\n",
      'eslint-suppressions.json': '{}\n',
      'src/old.ts': `${Array.from({ length: 40 }, (_, line) => `export const v${line} = ${line};`).join('\n')}\n`,
    },
    'branch point',
  );
  ok(origin, ['tag', 'v1', fork]);
  ok(origin, ['checkout', '-q', '-b', 'feature']);
  const old = readFileSync(join(origin, 'src/old.ts'), 'utf8');
  commit(
    origin,
    {
      'eslint.config.mjs': "export default ['head'];\n",
      'src/old.ts': null,
      'src/new.ts': `${old}export const added = true;\n`,
    },
    'head',
  );
  ok(origin, ['checkout', '-q', 'dev']);
  const base = commit(origin, { 'eslint-suppressions.json': '{"a.ts":{}}\n' }, 'base moved');
  ok(origin, ['checkout', '-q', '--detach', base]);
  ok(origin, ['merge', '-q', '--no-ff', '-m', 'Merge head into base', 'feature']);
  const merge = ok(origin, ['rev-parse', 'HEAD']).trim();
  ok(origin, ['update-ref', 'refs/pull/1/merge', merge]);
  ok(origin, ['checkout', '-q', 'dev']);
  // What github.com serves: partial clone filters and fetching a SHA by id.
  ok(origin, ['config', 'uploadpack.allowFilter', 'true']);
  ok(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return { url: `file://${origin}`, base, merge };
}

/** The fetch actions/checkout issues for a pull_request event with these inputs. */
function checkout(dir: string, url: string, merge: string, inputs: Step['with'] = {}): void {
  const depth = Number(inputs['fetch-depth'] ?? 1);
  const filter = inputs.filter;
  mkdirSync(dir);
  ok(dir, ['init', '-q']);
  ok(dir, ['remote', 'add', 'origin', url]);
  const args = ['-c', 'protocol.version=2', 'fetch', '-q', '--prune', '--no-recurse-submodules'];
  if (filter) {
    args.push(`--filter=${filter}`);
  }
  if (depth > 0) {
    args.push(`--depth=${depth}`, 'origin', `+${merge}:refs/remotes/pull/1/merge`);
  } else {
    args.push(
      'origin',
      '+refs/heads/*:refs/remotes/origin/*',
      '+refs/tags/*:refs/tags/*',
      `+${merge}:refs/remotes/pull/1/merge`,
    );
  }
  ok(dir, args);
  ok(dir, ['checkout', '-q', '--force', 'refs/remotes/pull/1/merge']);
}

/** Everything the Static Checks jobs and the runner they call ask git about the base. */
function observe(dir: string, base: string) {
  return {
    baseCommit: git(dir, ['cat-file', '-e', `${base}^{commit}`]).status,
    mergeBase: git(dir, ['merge-base', base, 'HEAD']).stdout.trim(),
    changed: git(dir, ['diff', '-z', '--name-only', '--diff-filter=ACMRTUXB', base, 'HEAD']).stdout,
    threeDot: git(dir, ['diff', '-z', '--name-only', `${base}...HEAD`]).stdout,
    renames: git(dir, ['diff', '--name-status', '-M', base, '--']).stdout,
    configChanged: git(dir, ['diff', '--quiet', base, 'HEAD', '--', 'eslint.config.mjs']).status,
    baseConfig: git(dir, ['show', `${base}:eslint.config.mjs`]).stdout,
  };
}

function checkoutInputs(job: string): NonNullable<Step['with']> {
  const step = workflow('static-checks.yml').jobs[job]?.steps?.find((entry) =>
    entry.uses?.startsWith('actions/checkout@'),
  );
  expect(step, `${job} checks the repository out`).toBeDefined();
  return step!.with ?? {};
}

test.describe('Static Checks checkout', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(120_000);
  });

  test('a blobless checkout still answers every base-diff question a full clone does @scenario:static-checks-checkout-keeps-base-diff-history', () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-checkout-'));
    try {
      const { url, base, merge } = pullRequestOrigin(root);
      const full = join(root, 'full');
      checkout(full, url, merge, { 'fetch-depth': 0 });
      const reference = observe(full, base);
      expect(reference.mergeBase).toBe(base);
      expect(reference.renames).toMatch(/^R\d+\tsrc\/old\.ts\tsrc\/new\.ts$/m);
      expect(reference.baseConfig).toBe("export default ['base'];\n");
      expect(reference.configChanged).toBe(1);

      for (const job of ['static-checks', 'eslint-sweep']) {
        const inputs = checkoutInputs(job);
        expect(inputs.filter, `${job} fetches blobless`).toBe('blob:none');
        const dir = join(root, job);
        checkout(dir, url, merge, inputs);
        // Blobless: the base-only config is not on disk until a step asks for it.
        expect(
          git(dir, ['cat-file', '-e', `${base}:eslint.config.mjs`], { GIT_NO_LAZY_FETCH: '1' })
            .status,
          `${job} skipped the base blobs`,
        ).not.toBe(0);
        expect(observe(dir, base), job).toEqual(reference);
      }

      // The control: the action's default shallow fetch loses the merge-base the
      // runner's three-dot diff needs.
      const shallow = join(root, 'shallow');
      checkout(shallow, url, merge);
      const cut = observe(shallow, base);
      expect(cut.mergeBase).not.toBe(base);
      expect(cut.threeDot).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Every `X/node_modules` directory `npm ci` creates for this lockfile, plus the root. */
function installedDirectories(): string[] {
  const lock = JSON.parse(readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, unknown>;
  };
  const nested = Object.keys(lock.packages)
    .filter((key) => !key.startsWith('node_modules/') && key.includes('/node_modules/'))
    .map((key) => key.slice(0, key.indexOf('/node_modules/') + '/node_modules'.length));
  return [...new Set(['node_modules', ...nested])].sort();
}

const SHARED_KEY =
  "node-modules-e2e-${{ runner.os }}-24.22.1-${{ hashFiles('package-lock.json') }}";

const lines = (value: unknown): string[] =>
  String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

test.describe('the shared installed dependency tree', () => {
  test.beforeEach(() => inOneProject());

  test('every job restoring it gets every installed directory, only for its own lockfile, and only from a finished npm ci @scenario:shared-installed-tree-is-complete-and-exact', () => {
    const expected = installedDirectories();
    const pathLists = new Set<string>();
    const participants: string[] = [];

    for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'))) {
      for (const [name, job] of Object.entries(workflow(file).jobs ?? {})) {
        const steps = job.steps ?? [];
        const restore = steps.find(
          (step) =>
            /^actions\/cache(\/restore)?@/.test(step.uses ?? '') && step.with?.key === SHARED_KEY,
        );
        if (!restore) {
          continue;
        }
        const where = `${file} ${name}`;
        participants.push(where);
        // One cache entry is shared only between identical path lists, and an
        // entry missing a workspace's node_modules would skip npm ci and leave
        // that workspace without its dependencies.
        pathLists.add(lines(restore.with?.path).join('|'));
        expect([...lines(restore.with?.path)].sort(), where).toEqual(expected);
        expect(restore.with?.['restore-keys'], `${where} restores no other lockfile's tree`).toBe(
          undefined,
        );
        // The key names the OS and Node version; the runner and Node must match it.
        expect(job['runs-on'], where).toBe('ubuntu-latest');
        const node = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
        expect(String(node?.with?.['node-version']), where).toBe('24.22.1');

        const install = steps.find((step) => step.run?.trim() === 'npm ci');
        expect(install, `${where} installs with npm ci`).toBeDefined();
        expect(install?.if, where).toBe(`steps.${restore.id}.outputs.cache-hit != 'true'`);

        if (restore.uses?.startsWith('actions/cache/restore@')) {
          const save = steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
          expect(save, `${where} saves what it installed`).toBeDefined();
          expect(save?.with?.key, where).toBe(
            `\${{ steps.${restore.id}.outputs.cache-primary-key }}`,
          );
          expect(lines(save?.with?.path), where).toEqual(lines(restore.with?.path));
          expect(install?.id, `${where} names its install step`).toBeDefined();
          expect(save?.if, `${where} saves only a finished install`).toBe(
            `steps.${install?.id}.outcome == 'success'`,
          );
          expect(steps.indexOf(save!), where).toBe(steps.indexOf(install!) + 1);
        }
      }
    }

    for (const required of [
      'static-checks.yml static-checks',
      'lighthouse.yml lighthouse',
      'frontend-review.yml client-build-regression',
      'playwright-mock.yml e2e_shards',
    ]) {
      expect(participants).toContain(required);
    }
    expect([...pathLists]).toHaveLength(1);
  });
});
