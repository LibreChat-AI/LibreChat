import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { changes, git, isSource } from './changes.mts';

const TEST_SUPPORT = [
  'packages/data-schemas/src/contracts/favorite.ts',
  'packages/data-schemas/src/contracts/lease.ts',
  'packages/data-schemas/src/contracts/future/domain.ts',
  'packages/data-schemas/src/app/conformance.ts',
  'packages/data-schemas/src/tenant/conformance.ts',
  'packages/data-schemas/src/tenant/harness.ts',
  'packages/data-schemas/src/tenant/probe.ts',
  'packages/data-schemas/src/methods/test-helpers.ts',
];

test('shared database test suites and fixtures are not production report targets', () => {
  for (const file of TEST_SUPPORT) assert.equal(isSource(file), false, file);
  for (const file of [
    'packages/data-schemas/src/methods/favorite.ts',
    'packages/data-schemas/src/methods/resourceLock.ts',
    'packages/data-schemas/src/app/store.ts',
    'packages/data-schemas/src/tenant/policy.ts',
    'packages/data-schemas/src/types/query.ts',
    'packages/api/src/contracts/feature.ts',
    'packages/api/src/feature/conformance.ts',
    'packages/api/src/feature/harness.ts',
    'packages/api/src/feature/probe.ts',
  ])
    assert.equal(isSource(file), true, file);
});

test('assertion-only contract edits skip report jobs while a production edit remains selected', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-contract-selection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const production = 'packages/data-schemas/src/methods/favorite.ts';
  const write = (file: string, source: string) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), source);
  };
  const commit = () => {
    git(['add', '.'], directory);
    git(
      [
        '-c',
        'user.name=Quality Test',
        '-c',
        'user.email=quality@example.invalid',
        'commit',
        '--no-gpg-sign',
        '-qm',
        'fixture',
      ],
      directory,
    );
    return git(['rev-parse', 'HEAD'], directory).trim();
  };
  git(['init', '-q'], directory);
  const assertion =
    'export function describeContract() { it("empty", () => expect([]).toEqual([])); }\n';
  for (const file of TEST_SUPPORT) write(file, assertion);
  write(production, 'export function getFavorites() { return []; }\n');
  const base = commit();
  for (const file of TEST_SUPPORT) write(file, assertion.replace('toEqual([])', 'toHaveLength(0)'));
  const head = commit();
  const selection = changes(base, head, directory);
  assert.deepEqual(selection.files, []);
  assert.deepEqual(selection.unsupported, []);

  const output = join(directory, '.git', 'quality-output');
  const select = (head: string) => {
    rmSync(output, { force: true });
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./changes.mts', import.meta.url)),
        '--base',
        base,
        '--head',
        head,
        '--scope',
        'data-schemas',
      ],
      {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' },
        encoding: 'utf8',
      },
    );
    assert.equal(run.status, 0, run.stderr);
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
  };
  assert.equal(select(head).hasChanges, 'false');
  assert.equal(select(head).reports, '[]');
  assert.equal(select(head).hasMutations, 'false');

  write(production, 'export function getFavorites() { return ["new"]; }\n');
  const mixedHead = commit();
  assert.deepEqual(
    changes(base, mixedHead, directory).files.map(({ file }) => file),
    [production],
  );
  assert.equal(select(mixedHead).workspaces, '["data-schemas"]');
  assert.equal(select(mixedHead).hasChanges, 'true');
  assert.equal(select(mixedHead).hasMutations, 'true');
});

for (const names of [
  [],
  ['data-schemas'],
  ['api'],
  ['server'],
  ['client'],
  ['data-schemas', 'api', 'server', 'client'],
]) {
  test(`report jobs select only changed backend owners: ${names.join(', ') || 'none'}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'quality-report-selection-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    git(['init', '-q'], directory);
    git(['config', 'user.name', 'Quality Test'], directory);
    git(['config', 'user.email', 'quality@example.invalid'], directory);
    git(['commit', '--allow-empty', '--no-gpg-sign', '-qm', 'base'], directory);
    const base = git(['rev-parse', 'HEAD'], directory).trim();
    const paths: Record<string, string> = {
      'data-schemas': 'packages/data-schemas/src/feature.ts',
      api: 'packages/api/src/feature.ts',
      server: 'api/server/feature.js',
      client: 'client/src/feature.ts',
    };
    for (const name of names) {
      const file = join(directory, paths[name]);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'export function feature() { return 1; }');
    }
    git(['add', '.'], directory);
    git(['commit', '--allow-empty', '--no-gpg-sign', '-qm', 'head'], directory);
    const select = (scope = 'all') => {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./changes.mts', import.meta.url)),
          '--base',
          base,
          '--scope',
          scope,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const selected = select();
    const risk = names.filter((name) => name !== 'client');
    assert.deepEqual(selected.workspaces, risk);
    assert.deepEqual(
      selected.reports.filter(({ task }: { task: { check: string } }) => task.check === 'risk'),
      risk.map((workspace) => ({ workspace, task: { check: 'risk', shard: 0 } })),
    );
    const mutations = names.includes('data-schemas') ? ['data-schemas'] : [];
    assert.deepEqual(selected.mutationWorkspaces, mutations);
    assert.deepEqual(
      selected.reports.filter(({ task }: { task: { check: string } }) => task.check === 'mutation'),
      mutations.flatMap((workspace) =>
        [1, 2, 3, 4].map((shard) => ({ workspace, task: { check: 'mutation', shard } })),
      ),
    );
    for (const scope of ['data-schemas', 'api', 'server']) {
      const narrowed = select(scope);
      assert.deepEqual(narrowed.workspaces, names.includes(scope) ? [scope] : []);
      assert.ok(
        narrowed.reports.every(({ workspace }: { workspace: string }) => workspace === scope),
      );
      if (scope !== 'data-schemas') assert.deepEqual(narrowed.mutationWorkspaces, []);
    }
  });
}
