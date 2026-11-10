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
    return readFileSync(output, 'utf8');
  };
  assert.equal(select(head), 'workspaces=[]\nhasChanges=false\n');

  write(production, 'export function getFavorites() { return ["new"]; }\n');
  const mixedHead = commit();
  assert.deepEqual(
    changes(base, mixedHead, directory).files.map(({ file }) => file),
    [production],
  );
  assert.equal(select(mixedHead), 'workspaces=["data-schemas"]\nhasChanges=true\n');
});
