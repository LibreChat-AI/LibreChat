import { test } from 'node:test';
import { delimiter, dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { applySkip, estimate, fileSeconds, listedFiles, partition } from './playwright-shards.mjs';

const script = fileURLToPath(new URL('./playwright-shards.mjs', import.meta.url));
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));

/** A `--list --reporter=json` report: one top-level suite per file, tests nested in describes. */
function listing(files) {
  return {
    errors: [],
    suites: Object.entries(files).map(([file, tests]) => ({
      file,
      specs: [],
      suites: [
        {
          file,
          specs: Array.from({ length: tests }, (_, i) => ({ title: `t${i}`, tests: [{}] })),
          suites: [],
        },
      ],
    })),
  };
}

function scratch(t) {
  const dir = mkdtempSync(join(scriptsDir, '.playwright-shards-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function plan(t, { files, timings, shard, reserve = '', skip = '' }) {
  const dir = scratch(t);
  writeFileSync(join(dir, 'list.json'), JSON.stringify(listing(files)));
  writeFileSync(join(dir, 'timings.json'), JSON.stringify({ files: timings }));
  const out = join(dir, 'out', 'shard.txt');
  const result = spawnSync(
    process.execPath,
    [
      script,
      'plan',
      '--list',
      join(dir, 'list.json'),
      '--timings',
      join(dir, 'timings.json'),
      '--shard',
      shard,
      '--reserve',
      reserve,
      '--skip',
      skip,
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return {
    files: readFileSync(out, 'utf8').split('\n').filter(Boolean),
    stdout: result.stdout,
  };
}

const suite = {
  'a.spec.ts': 3,
  'b.spec.ts': 1,
  'c.spec.ts': 2,
  'scenarios/d.spec.ts': 4,
  'scenarios/e.spec.ts': 1,
  'f.spec.ts': 5,
  'g.spec.ts': 2,
};
const recorded = {
  'a.spec.ts': 30,
  'b.spec.ts': 120,
  'c.spec.ts': 10,
  'scenarios/d.spec.ts': 40,
  'f.spec.ts': 50,
  'g.spec.ts': 15,
  'removed.spec.ts': 999,
};

test('every listed file runs in exactly one shard, whatever the shard count', (t) => {
  for (const total of [1, 2, 3, 6, 10]) {
    const seen = [];
    for (let index = 1; index <= total; index++) {
      seen.push(...plan(t, { files: suite, timings: recorded, shard: `${index}/${total}` }).files);
    }
    assert.deepEqual(seen.sort(), Object.keys(suite).sort(), `total ${total}`);
  }
});

test('shards balance recorded seconds rather than test counts', () => {
  const counts = listedFiles(listing(suite));
  const { loads, shards } = partition(estimate(counts, recorded), 2);
  /** The 120s single-test file sits with at most one small file: halves by test count would
   *  have paired it with four others and doubled that shard. */
  assert.ok(shards[0].includes('b.spec.ts') && shards[0].length <= 2, `${shards[0]}`);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 30, `loads ${loads}`);
});

test('an unrecorded file is estimated from its test count at the recorded mean per test', () => {
  const counts = listedFiles(listing(suite));
  const estimates = estimate(counts, recorded);
  const known = [
    'a.spec.ts',
    'b.spec.ts',
    'c.spec.ts',
    'scenarios/d.spec.ts',
    'f.spec.ts',
    'g.spec.ts',
  ];
  const perTest =
    known.reduce((sum, file) => sum + recorded[file], 0) /
    known.reduce((sum, file) => sum + suite[file], 0);
  assert.equal(estimates.get('scenarios/e.spec.ts'), perTest);
  assert.equal(estimates.has('removed.spec.ts'), false);
  assert.equal(estimate(counts, {}).get('f.spec.ts'), 5);
});

test('the plan is deterministic and ties resolve by name and shard index', () => {
  const counts = new Map([
    ['x.spec.ts', 1],
    ['y.spec.ts', 1],
    ['z.spec.ts', 1],
  ]);
  const timings = { 'x.spec.ts': 5, 'y.spec.ts': 5, 'z.spec.ts': 5 };
  const first = partition(estimate(counts, timings), 2);
  const second = partition(estimate(new Map([...counts].reverse()), timings), 2);
  assert.deepEqual(first, second);
  assert.deepEqual(first.shards, [['x.spec.ts', 'z.spec.ts'], ['y.spec.ts']]);
});

test('a reservation hands the reserved shard less of the suite', () => {
  const counts = listedFiles(listing(suite));
  const estimates = estimate(counts, recorded);
  const plain = partition(estimates, 3);
  const reserved = partition(estimates, 3, [100, 0, 0]);
  const seconds = (files) => files.reduce((sum, file) => sum + estimates.get(file), 0);
  assert.ok(seconds(reserved.shards[0]) < seconds(plain.shards[0]));
  assert.deepEqual(reserved.shards.flat().sort(), Object.keys(suite).sort());
});

test('graduated skips leave the pool before planning, and never empty it', (t) => {
  const counts = listedFiles(listing(suite));
  const skipped = applySkip(counts, 'specs/mock/b.spec.ts specs/mock/unknown.spec.ts');
  assert.equal(skipped.dropped, 1);
  assert.equal(skipped.counts.has('b.spec.ts'), false);
  assert.equal(applySkip(counts, 'specs/mock/unknown.spec.ts').dropped, 0);
  const everything = Object.keys(suite)
    .map((file) => `specs/mock/${file}`)
    .join(' ');
  assert.equal(applySkip(counts, everything).counts, counts);

  const seen = [];
  for (const shard of ['1/2', '2/2']) {
    const result = plan(t, {
      files: suite,
      timings: recorded,
      shard,
      skip: 'specs/mock/f.spec.ts',
    });
    assert.match(result.stdout, /codegraph-e2e-skip: dropped 1 graduated specs/);
    seen.push(...result.files);
  }
  assert.deepEqual(
    seen.sort(),
    Object.keys(suite)
      .filter((file) => file !== 'f.spec.ts')
      .sort(),
  );
});

test('a listing with load errors, or a malformed shard, fails the plan', (t) => {
  assert.throws(
    () => listedFiles({ errors: [{ message: 'SyntaxError' }], suites: [] }),
    /SyntaxError/,
  );
  const dir = scratch(t);
  writeFileSync(join(dir, 'list.json'), JSON.stringify(listing(suite)));
  writeFileSync(join(dir, 'timings.json'), JSON.stringify({ files: recorded }));
  for (const [shard, reserve] of [
    ['0/2', ''],
    ['3/2', ''],
    ['x', ''],
    ['1/2', '3:10'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        script,
        'plan',
        '--list',
        join(dir, 'list.json'),
        '--timings',
        join(dir, 'timings.json'),
        '--shard',
        shard,
        '--reserve',
        reserve,
        '--out',
        join(dir, 'out.txt'),
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, `${shard} ${reserve}`);
  }
});

/** The body of playwright-mock.yml's sharded run step, with its matrix shard filled in. */
function shardStep(shard) {
  const lines = readFileSync(
    new URL('../workflows/playwright-mock.yml', import.meta.url),
    'utf8',
  ).split('\n');
  const name = lines.findIndex((line) => line.trim() === '- name: Run full mock-LLM Tier-1 e2e');
  const run = lines.findIndex((line, i) => i > name && line.trim() === 'run: |');
  assert.ok(name !== -1 && run !== -1, 'the sharded run step is missing');
  const indent = lines[run + 1].search(/\S/);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) {
      break;
    }
    body.push(line.slice(indent));
  }
  const script = body.join('\n').replaceAll('${{ matrix.shard }}', shard);
  assert.doesNotMatch(script, /\$\{\{/, 'the step uses an expression this test does not fill in');
  return script;
}

/**
 * Runs the step as the runner's bash does, with `npx` stubbed: the listing call writes the
 * fixture, and any other call is logged as a test run and exits with `status`.
 */
function runStep(t, { files, shard, reserve = '', skip = '', status = 0 }) {
  const dir = scratch(t);
  mkdirSync(join(dir, '.github', 'scripts'), { recursive: true });
  copyFileSync(script, join(dir, '.github', 'scripts', 'playwright-shards.mjs'));
  writeFileSync(join(dir, 'listing.json'), JSON.stringify(listing(files)));
  mkdirSync(join(dir, 'bin'));
  const npx = join(dir, 'bin', 'npx');
  writeFileSync(
    npx,
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" --list "*)',
      '    mkdir -p "$(dirname "$PLAYWRIGHT_JSON_OUTPUT_FILE")"',
      '    cp listing.json "$PLAYWRIGHT_JSON_OUTPUT_FILE"',
      '    exit 0 ;;',
      'esac',
      'echo "$*" >> runs.log',
      `exit ${status}`,
      '',
    ].join('\n'),
  );
  chmodSync(npx, 0o755);
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', shardStep(shard)],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [join(dir, 'bin'), dirname(process.execPath), process.env.PATH].join(delimiter),
        E2E_SKIP: skip,
        E2E_SHARD_RESERVE: reserve,
        E2E_SHARD_TIMINGS: JSON.stringify({ files: recorded }),
      },
    },
  );
  const log = join(dir, 'runs.log');
  const runs = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.status, output: result.stdout + result.stderr, runs };
}

test('a shard the plan leaves empty passes without starting Playwright', (t) => {
  const pair = { 'a.spec.ts': 3, 'b.spec.ts': 1 };
  const extra = runStep(t, { files: pair, shard: '3/3' });
  assert.equal(extra.status, 0, extra.output);
  assert.match(extra.output, /this shard drew no spec files/);
  assert.deepEqual(extra.runs, []);

  const reserved = runStep(t, { files: pair, shard: '1/2', reserve: '1:130' });
  assert.equal(reserved.status, 0, reserved.output);
  assert.deepEqual(reserved.runs, []);

  const loaded = runStep(t, { files: pair, shard: '2/2', reserve: '1:130' });
  assert.equal(loaded.status, 0, loaded.output);
  assert.deepEqual(loaded.runs, [
    'playwright test --config=e2e/playwright.config.mock.ts --test-list=e2e/.generated/shard-tests.txt',
  ]);
});

test('a shard with files still fails when its tests fail, and an empty listing fails the plan', (t) => {
  const failed = runStep(t, { files: suite, shard: '1/2', status: 1 });
  assert.notEqual(failed.status, 0, failed.output);
  assert.equal(failed.runs.length, 1);

  const empty = runStep(t, { files: {}, shard: '1/2' });
  assert.notEqual(empty.status, 0, empty.output);
  assert.match(empty.output, /playwright --list found no spec files/);
  assert.deepEqual(empty.runs, []);
});

test('record sums every attempt per file from JSON reports', (t) => {
  const dir = scratch(t);
  const report = (file, durations) => ({
    suites: [
      {
        file,
        specs: [],
        suites: [
          {
            file,
            specs: [{ tests: [{ results: durations.map((duration) => ({ duration })) }] }],
            suites: [],
          },
        ],
      },
    ],
  });
  assert.deepEqual([...fileSeconds(report('a.spec.ts', [1000, 2500]))], [['a.spec.ts', 3.5]]);
  mkdirSync(join(dir, 'memory-1', 'nested'), { recursive: true });
  mkdirSync(join(dir, 'memory-2'));
  writeFileSync(
    join(dir, 'memory-1', 'nested', 'results.json'),
    JSON.stringify(report('a.spec.ts', [1000])),
  );
  writeFileSync(
    join(dir, 'memory-2', 'results.json'),
    JSON.stringify(report('b.spec.ts', [2000, 500])),
  );
  writeFileSync(join(dir, 'memory-2', 'other.json'), JSON.stringify(report('c.spec.ts', [9000])));
  const out = join(dir, 'timings.json');
  const result = spawnSync(process.execPath, [script, 'record', '--out', out, dir], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
    files: { 'a.spec.ts': 1, 'b.spec.ts': 2.5 },
  });
});

test('record averages a file over the runs that measured it', (t) => {
  const dir = scratch(t);
  const report = (entries) => ({
    suites: entries.map(([file, duration]) => ({
      file,
      specs: [{ tests: [{ results: [{ duration }] }] }],
      suites: [],
    })),
  });
  for (const [run, entries] of [
    [
      'run-1',
      [
        ['a.spec.ts', 1000],
        ['b.spec.ts', 4000],
      ],
    ],
    ['run-2', [['a.spec.ts', 3000]]],
  ]) {
    mkdirSync(join(dir, run, 'memory-1'), { recursive: true });
    writeFileSync(join(dir, run, 'memory-1', 'results.json'), JSON.stringify(report(entries)));
  }
  const out = join(dir, 'timings.json');
  const result = spawnSync(
    process.execPath,
    [script, 'record', '--out', out, join(dir, 'run-1'), join(dir, 'run-2')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
    files: { 'a.spec.ts': 2, 'b.spec.ts': 4 },
  });
});

test('the committed timings are a flat map of spec files to seconds', () => {
  const { files } = JSON.parse(
    readFileSync(new URL('../../e2e/timings.mock.json', import.meta.url), 'utf8'),
  );
  const entries = Object.entries(files);
  assert.ok(entries.length > 0);
  for (const [file, seconds] of entries) {
    assert.match(file, /\.spec\.ts$/);
    assert.ok(Number.isFinite(seconds) && seconds >= 0, file);
  }
});
