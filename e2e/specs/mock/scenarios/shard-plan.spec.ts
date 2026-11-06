import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * CI splits the mock suite across ten memory shards with
 * `.github/scripts/playwright-shards.mjs`, planned from `e2e/timings.mock.json`. These
 * scenarios run the real `plan` and `record` commands over temporary fixtures (and the
 * committed timings) and read what they write; no browser is involved.
 */

const SCRIPT = resolve(repoRoot, '.github/scripts/playwright-shards.mjs');
const TIMINGS = resolve(repoRoot, 'e2e/timings.mock.json');
const SHARDS = 10;

/** A `playwright test --list --reporter=json` report: tests nested in a describe per file. */
function listing(files: Record<string, number>) {
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

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shard-plan-'));
  test.info().attach('scratch', { body: dir });
  return dir;
}

type Plan = { shards: string[][]; estimates: number[] };

/** Every shard's plan, the way the ten CI jobs each compute their own. */
function planAll(
  dir: string,
  options: { files: Record<string, number>; timings: string; reserve?: string; skip?: string },
): Plan {
  const list = join(dir, 'list.json');
  writeFileSync(list, JSON.stringify(listing(options.files)));
  const shards: string[][] = [];
  let estimates: number[] = [];
  for (let index = 1; index <= SHARDS; index++) {
    const out = join(dir, `shard-${index}.txt`);
    const result = run(process.execPath, [
      SCRIPT,
      'plan',
      '--list',
      list,
      '--timings',
      options.timings,
      '--shard',
      `${index}/${SHARDS}`,
      '--reserve',
      options.reserve ?? '',
      '--skip',
      options.skip ?? '',
      '--out',
      out,
    ]);
    expect(result.status, result.output).toBe(0);
    shards.push(readFileSync(out, 'utf8').split('\n').filter(Boolean));
    const line = /estimated seconds per shard: ([\d ]+)/.exec(result.stdout);
    expect(line, result.output).not.toBeNull();
    estimates = line![1].trim().split(' ').map(Number);
  }
  return { shards, estimates };
}

function expectExactCover(shards: string[][], expected: string[]): void {
  const planned = shards.flat();
  expect(new Set(planned).size, 'no file is planned on two shards').toBe(planned.length);
  expect([...planned].sort()).toEqual([...expected].sort());
}

/** Files of every shape the planner meets: recorded, unrecorded, empty, nested. */
const FIXTURE: Record<string, number> = Object.fromEntries([
  ...Array.from({ length: 30 }, (_, i) => [`scenarios/recorded-${i}.spec.ts`, 1 + (i % 5)]),
  ...Array.from({ length: 8 }, (_, i) => [`unrecorded-${i}.spec.ts`, 2 + i]),
  ['scenarios/empty.spec.ts', 0],
]);
const FIXTURE_TIMINGS = Object.fromEntries(
  Array.from({ length: 30 }, (_, i) => [`scenarios/recorded-${i}.spec.ts`, 5 + i * 7]),
);

test.beforeEach(() => {
  inOneProject();
});

test('the committed timings plan ten memory shards close to an even split @scenario:pr-memory-shards-finish-balanced', () => {
  const dir = scratch();
  try {
    const { files } = JSON.parse(readFileSync(TIMINGS, 'utf8')) as {
      files: Record<string, number>;
    };
    const suite = Object.fromEntries(Object.keys(files).map((file) => [file, 1]));
    const { shards, estimates } = planAll(dir, {
      files: suite,
      timings: TIMINGS,
      reserve: '1:130',
    });
    expectExactCover(shards, Object.keys(files));
    const total = Object.values(files).reduce((sum, seconds) => sum + seconds, 0) + 130;
    const even = total / SHARDS;
    expect(Math.max(...estimates), `per-shard estimates ${estimates.join(' ')}`).toBeLessThan(
      even * 1.05,
    );
    expect(Math.min(...estimates), `per-shard estimates ${estimates.join(' ')}`).toBeGreaterThan(
      even * 0.95,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every listed spec runs in exactly one shard @scenario:every-listed-spec-runs-in-exactly-one-shard', () => {
  const dir = scratch();
  try {
    const timings = join(dir, 'timings.json');
    writeFileSync(timings, JSON.stringify({ files: FIXTURE_TIMINGS }));
    const { shards } = planAll(dir, { files: FIXTURE, timings, reserve: '1:130' });
    expectExactCover(shards, Object.keys(FIXTURE));
    expect(planAll(dir, { files: FIXTURE, timings, reserve: '1:130' }).shards).toEqual(shards);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('graduated skips leave exactly the kept specs across the shards @scenario:graduated-skips-keep-exact-coverage', () => {
  const dir = scratch();
  try {
    const timings = join(dir, 'timings.json');
    writeFileSync(timings, JSON.stringify({ files: FIXTURE_TIMINGS }));
    const skipped = ['scenarios/recorded-3.spec.ts', 'unrecorded-2.spec.ts'];
    const { shards } = planAll(dir, {
      files: FIXTURE,
      timings,
      skip: skipped.map((file) => `specs/mock/${file}`).join(' '),
    });
    expectExactCover(
      shards,
      Object.keys(FIXTURE).filter((file) => !skipped.includes(file)),
    );
    const everything = Object.keys(FIXTURE)
      .map((file) => `specs/mock/${file}`)
      .join(' ');
    expectExactCover(
      planAll(dir, { files: FIXTURE, timings, skip: everything }).shards,
      Object.keys(FIXTURE),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record times a spec at the mean of the runs that measured it @scenario:record-averages-a-spec-over-runs', () => {
  const dir = scratch();
  try {
    const report = (entries: [string, number[]][]) => ({
      suites: entries.map(([file, durations]) => ({
        file,
        specs: [],
        suites: [
          {
            file,
            specs: [{ tests: [{ results: durations.map((duration) => ({ duration })) }] }],
            suites: [],
          },
        ],
      })),
    });
    const runs: Record<string, Record<string, [string, number[]][]>> = {
      'run-1': {
        'playwright-report-memory-1-of-10': [['a.spec.ts', [10000]]],
        'playwright-report-memory-2-of-10': [['b.spec.ts', [4000, 2000]]],
      },
      'run-2': {
        'playwright-report-memory-1-of-10': [['b.spec.ts', [3000]]],
        'playwright-report-memory-2-of-10': [['a.spec.ts', [20000]]],
      },
      'run-3': {
        'playwright-report-memory-1-of-10': [['a.spec.ts', [30000]]],
      },
    };
    for (const [runName, shards] of Object.entries(runs)) {
      for (const [shard, entries] of Object.entries(shards)) {
        mkdirSync(join(dir, runName, shard), { recursive: true });
        writeFileSync(join(dir, runName, shard, 'results.json'), JSON.stringify(report(entries)));
      }
    }
    const out = join(dir, 'timings.json');
    const result = run(process.execPath, [
      SCRIPT,
      'record',
      '--out',
      out,
      ...Object.keys(runs).map((name) => join(dir, name)),
    ]);
    expect(result.status, result.output).toBe(0);
    /** a: 10, 20 and 30 s in three runs; b: 6 s (both attempts) and 3 s in two runs. */
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      files: { 'a.spec.ts': 20, 'b.spec.ts': 4.5 },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
