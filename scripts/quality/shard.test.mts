import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';

import { parseShard, shardTargets } from './shard.mts';
import { mutationTarget } from './risk.mts';
import { git } from './changes.mts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runner = fileURLToPath(new URL('./run.mts', import.meta.url));

const targets = Object.freeze(
  Array.from({ length: 8 }, (_value, index) =>
    Object.freeze(
      mutationTarget(
        `file-${index}.ts`,
        'const first = (ok) => ok ? true : false;\nconst second = () => false;',
        [{ start: 1, count: 2 }],
      ),
    ),
  ),
);

for (const [index, expected] of [
  [1, [0, 3, 6]],
  [2, [1, 4, 7]],
  [3, [2, 5]],
] as const) {
  test(`shard ${index}/3 retains whole files and their full function and mutation ranges`, () => {
    const shard = parseShard(`${index}/3`, 'mutation');
    const chosen = shardTargets(targets, shard);
    assert.deepEqual(
      chosen,
      expected.map((offset) => targets[offset]),
    );
    for (const [position, offset] of expected.entries()) {
      assert.equal(chosen[position], targets[offset]);
      assert.equal(chosen[position].functions.length, 2);
      assert.equal(chosen[position].mutate, targets[offset].mutate);
    }
    assert.deepEqual(shardTargets(targets, shard), chosen);
  });
}

test('three shards contain every full target exactly once without mutating input order', () => {
  const before = JSON.stringify(targets);
  const union = [1, 2, 3].flatMap((index) => shardTargets(targets, { index, total: 3 }));
  assert.equal(union.length, targets.length);
  assert.equal(new Set(union).size, targets.length);
  assert.deepEqual(new Set(union), new Set(targets));
  assert.deepEqual(
    union.flatMap(({ mutate }) => mutate).sort(),
    targets.flatMap(({ mutate }) => mutate).sort(),
  );
  assert.equal(JSON.stringify(targets), before);
});

test('omitting --shard retains all original targets and allows risk checks', () => {
  assert.equal(parseShard(undefined, 'mutation'), undefined);
  assert.equal(parseShard(undefined, 'risk'), undefined);
  assert.equal(shardTargets(targets), targets);
  assert.deepEqual(shardTargets(targets, parseShard('1/1', 'mutation')), targets);
});

test('equal function counts use file order regardless of input order without mutating input', () => {
  const reversed = Object.freeze([...targets].reverse());
  const before = JSON.stringify(reversed);
  for (const index of [1, 2, 3]) {
    const shard = parseShard(`${index}/3`, 'mutation');
    assert.deepEqual(shardTargets(reversed, shard), shardTargets(targets, shard));
  }
  assert.equal(JSON.stringify(reversed), before);
  assert.equal(shardTargets(reversed), reversed);
  assert.deepEqual(shardTargets(reversed, parseShard('1/1', 'mutation')), targets);
});

test('function-weighted round robin spreads the known target file workload across three shards', () => {
  const workload = Object.freeze(
    (
      [
        ['pool.ts', 25],
        ['import.ts', 19],
        ['nativefavorite.ts', 13],
        ['mongo.ts', 11],
        ['migrations.ts', 9],
        ['user.ts', 8],
        ['backend.ts', 3],
        ['favorites/mongo.ts', 1],
        ['methods/createMethods.ts', 1],
      ] as const
    ).map(([file, count]) =>
      Object.freeze({
        file,
        functions: Object.freeze(Array.from({ length: count }, (_value, index) => index)),
      }),
    ),
  );
  const before = JSON.stringify(workload);
  const expected = [
    ['pool.ts', 'mongo.ts', 'backend.ts'],
    ['import.ts', 'migrations.ts', 'favorites/mongo.ts'],
    ['nativefavorite.ts', 'user.ts', 'methods/createMethods.ts'],
  ];
  const shuffled = Object.freeze([...workload].reverse());
  const shards = [1, 2, 3].map((index) => {
    const shard = parseShard(`${index}/3`, 'mutation');
    const chosen = shardTargets(shuffled, shard);
    assert.deepEqual(
      chosen.map(({ file }) => file),
      expected[index - 1],
    );
    assert.deepEqual(chosen, shardTargets(workload, shard));
    return chosen;
  });
  const union = shards.flat();
  assert.equal(union.length, workload.length);
  assert.equal(new Set(union).size, workload.length);
  assert.deepEqual(new Set(union), new Set(workload));
  assert.deepEqual(
    shards.map((chosen) => chosen.reduce((sum, target) => sum + target.functions.length, 0)),
    [39, 29, 22],
  );
  assert.equal(JSON.stringify(workload), before);
  assert.equal(shardTargets(shuffled), shuffled);
});

test('a shard beyond the number of selected target files is empty', () => {
  assert.deepEqual(shardTargets(targets.slice(0, 1), parseShard('2/3', 'mutation')), []);
  assert.deepEqual(shardTargets([], parseShard('1/3', 'mutation')), []);
});

for (const value of [
  '0/2',
  '4/3',
  'foo',
  '1/0',
  '1.1/2',
  '1/2/3',
  '',
  '-1/2',
  '1/-2',
  '01/2',
  '1/02',
  '+1/2',
  ' 1/2',
  '1/2 ',
  '1e1/20',
  '1/9007199254740992',
]) {
  test(`invalid shard ${JSON.stringify(value)} is rejected`, () => {
    assert.throws(() => parseShard(value, 'mutation'), /--shard must be INDEX\/COUNT/u);
  });
}

test('risk checks reject --shard before attempting source selection', () => {
  assert.throws(() => parseShard('1/3', 'risk'), /only allowed for mutation/u);
  const result = spawnSync(
    process.execPath,
    [
      runner,
      '--workspace',
      'data-schemas',
      '--check',
      'risk',
      '--shard',
      '1/3',
      '--base',
      'nonexistent-shard-test-ref',
    ],
    { cwd: root, encoding: 'utf8', timeout: 15000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--shard is only allowed for mutation checks/u);
  assert.doesNotMatch(result.stderr, /Not a valid object name/u);
});

test('empty sharded CLI runs pass with truthful metadata; unsharded output stays unchanged', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'quality-shard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_DIR: git(['rev-parse', '--absolute-git-dir'], root).trim(),
    GIT_WORK_TREE: directory,
    GITHUB_STEP_SUMMARY: '',
  };
  const output = join(directory, 'coverage/changes/data-schemas/mutation');
  for (const shard of ['2/3', undefined]) {
    const result = spawnSync(
      process.execPath,
      [
        runner,
        '--workspace',
        'data-schemas',
        '--check',
        'mutation',
        '--base',
        'HEAD',
        ...(shard ? ['--shard', shard] : []),
      ],
      { cwd: directory, env, encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    const selection = JSON.parse(readFileSync(join(output, 'selection.json'), 'utf8'));
    assert.equal(selection.workspace, 'data-schemas');
    assert.deepEqual(selection.files, []);
    if (shard) {
      assert.deepEqual(selection.shard, { index: 2, total: 3 });
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'mutation.json'), 'utf8')), {
        schemaVersion: '1.0',
        files: {},
      });
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'progress.json'), 'utf8')), {
        complete: true,
        completed: 0,
        total: 0,
        staticCompleted: 0,
        staticTotal: 0,
      });
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'all-functions.json'), 'utf8')), []);
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'functions.json'), 'utf8')), []);
      assert.match(result.stdout, /mutation \(shard 2\/3\)/u);
      assert.match(result.stdout, /No changed functions for shard\./u);
    } else {
      assert.equal(selection.shard, undefined);
      assert.equal(existsSync(join(output, 'all-functions.json')), false);
      assert.equal(existsSync(join(output, 'functions.json')), false);
      assert.equal(result.stdout, '## data-schemas: mutation\n\nNo changed source files.\n\n');
    }
  }
});
