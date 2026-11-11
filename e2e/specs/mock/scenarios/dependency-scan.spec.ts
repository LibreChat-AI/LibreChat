import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * The unused-dependency gate counts a package as used when the repository's own
 * source imports it. `scripts/imports.mts` is that extraction for the Static Checks
 * job and the local runner; these scenarios run it, and its fixture suite, the way
 * the job does.
 */

const SUITE = resolve(repoRoot, 'scripts/imports.test.mts');
const CLI = resolve(repoRoot, 'scripts/imports.mts');
const DIRS = ['.', 'client', 'api', 'packages/client', 'packages/api'];

/** One named test of the extractor's fixture suite, which builds a throwaway git repository. */
function suiteCase(name: string) {
  const result = run(process.execPath, ['--test', `--test-name-pattern=${name}`, SUITE]);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toMatch(/ℹ pass [1-9]/);
  expect(result.output).toMatch(/ℹ fail 0/);
}

/**
 * The recursive grep the job ran before, restricted to what it should always have
 * read: the extractor's patterns and subpath stripping over the checkout, minus
 * installs, build output, `.git` and local `.claude` worktrees.
 */
function legacyScan(dir: string, cwd = repoRoot): string[] {
  const include = ['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].map(
    (ext) => `--include=*.${ext}`,
  );
  const exclude = [
    '--exclude-dir=node_modules',
    '--exclude-dir=dist',
    '--exclude-dir=coverage',
    '--exclude-dir=.git',
    '--exclude-dir=.claude',
    // Traces retain copied dependency bundles; they are not repository source.
    '--exclude-dir=.test-results',
  ];
  const patterns = [
    `require\\(\\s*['"][a-zA-Z0-9@/._-]+['"]\\s*\\)`,
    `\\bimport\\b[^\\n]*?\\bfrom\\s*['"][a-zA-Z0-9@/._-]+['"]`,
    `\\bexport\\b[^\\n]*?\\bfrom\\s*['"][a-zA-Z0-9@/._-]+['"]`,
    `\\bimport\\s*['"][a-zA-Z0-9@/._-]+['"]`,
  ];
  const names = new Set<string>();
  for (const pattern of patterns) {
    const result = run('grep', ['-rhoP', pattern, dir, ...include, ...exclude], { cwd });
    for (const line of result.stdout.split('\n')) {
      // The specifier closes the match: a quote earlier on the line is someone else's.
      const specifier = line.match(/['"]([a-zA-Z0-9@/._-]+)['"]\s*\)?$/)?.[1];
      if (!specifier) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      const parts = specifier.split('/');
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (!specifier.startsWith('@') || parts.length > 1) names.add(name);
    }
  }
  return [...names].sort();
}

test.describe('dependency source extraction', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(120_000);
  });

  test('imports inside node_modules, dist and nested worktrees never count as usage @scenario:dependency-scan-ignores-installed-packages', () => {
    suiteCase('counts source usage and ignores installed dependencies and build output');
  });

  test('require, import, import type, side-effect and re-export forms all count, scoped subpaths reduced to the package @scenario:dependency-scan-keeps-import-forms', () => {
    suiteCase('recognizes every import form the gate relies on');
    suiteCase('reduces specifiers to their package and drops relative ones');
  });

  test('the job command writes one sorted list per workspace and rejects a malformed target @scenario:dependency-scan-writes-workspace-lists', () => {
    suiteCase('the CLI writes each directory as a sorted list');
    suiteCase('fails instead of reporting nothing outside a git checkout');
  });

  test('trace resource imports never enter the source comparison @scenario:dependency-scan-ignores-trace-resources', () => {
    const root = mkdtempSync(join(tmpdir(), 'dependency-traces-'));
    try {
      expect(run('git', ['init', '-q'], { cwd: root }).status).toBe(0);
      writeFileSync(join(root, '.gitignore'), '.test-results/\n');
      writeFileSync(join(root, 'source.ts'), "import 'source-only';\n");
      const resources = join(root, 'e2e', '.test-results', 'traces', 'resources');
      mkdirSync(resources, { recursive: true });
      writeFileSync(join(resources, 'bundle.js'), "import 'trace-only';\n");
      const output = join(root, 'imports.txt');
      const result = run(process.execPath, [CLI, `.=${output}`], { cwd: root });
      expect(result.status, result.output).toBe(0);
      const listed = readFileSync(output, 'utf8').trim().split('\n');
      expect(listed).toEqual(['source-only']);
      expect(legacyScan('.', root)).toEqual(listed);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('on this checkout every workspace list matches the legacy extraction over its source @scenario:dependency-scan-matches-legacy-on-source', () => {
    const out = mkdtempSync(join(tmpdir(), 'dependency-scan-'));
    try {
      const targets = DIRS.map((dir, index) => ({ dir, file: join(out, `${index}.txt`) }));
      const started = Date.now();
      const result = run(process.execPath, [
        CLI,
        ...targets.map(({ dir, file }) => `${dir}=${file}`),
      ]);
      expect(result.status, result.output).toBe(0);
      expect(Date.now() - started, 'one listing, not a node_modules walk').toBeLessThan(30_000);
      for (const { dir, file } of targets) {
        const listed = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        expect(listed.length, `${dir} lists its imports`).toBeGreaterThan(0);
        expect(listed, dir).toEqual(legacyScan(dir));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
