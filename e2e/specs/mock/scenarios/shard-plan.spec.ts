import yaml from 'js-yaml';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * CI splits the mock suite across fifteen memory shards with
 * `.github/scripts/playwright-shards.mjs`, planned from the timings each run resolves once
 * for all of its shards, or from `e2e/timings.mock.json` when it has none. These scenarios
 * run the real `plan` and `record` commands, and the workflow's own hand-off steps, over
 * temporary fixtures (and the committed timings) and read what they write; no browser is
 * involved.
 */

const SCRIPT = resolve(repoRoot, '.github/scripts/playwright-shards.mjs');
const TIMINGS = resolve(repoRoot, 'e2e/timings.mock.json');
const SHARDS = 15;

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

/** Every shard's plan, the way the fifteen CI jobs each compute their own. */
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

type Step = { id?: string; if?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

/** The Playwright workflow as GitHub reads it. */
function mockWorkflow(): Workflow {
  return yaml.load(
    readFileSync(resolve(repoRoot, '.github/workflows/playwright-mock.yml'), 'utf8'),
  ) as Workflow;
}

/** A workflow step's script, run the way the runner runs it, in a scratch checkout. */
function bash(dir: string, script: string, env: Record<string, string>): string {
  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

/** What the `Shard timings` job hands the shards for one restored cache entry, or for none. */
function resolved(dir: string, cached?: string): string {
  if (cached !== undefined) {
    mkdirSync(join(dir, 'e2e/.generated'), { recursive: true });
    writeFileSync(join(dir, 'e2e/.generated/shard-timings.json'), cached);
  }
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  const step = mockWorkflow().jobs.shard_timings.steps.find((entry) => entry.id === 'read');
  bash(dir, step?.run ?? 'exit 1', { GITHUB_OUTPUT: output });
  return readFileSync(output, 'utf8')
    .replace(/^timings=/, '')
    .trimEnd();
}

/**
 * The timings file a shard plans from, given what the resolver handed it: the lines of the
 * shard step that run before Playwright lists the suite.
 */
function shardTimings(dir: string, handed: string): string {
  const step = mockWorkflow().jobs.e2e_shards.steps.find(
    (entry) => entry.if === "matrix.suite == 'full'",
  );
  const [handOff] = (step?.run ?? 'exit 1').split('PLAYWRIGHT_JSON_OUTPUT_FILE');
  return bash(dir, `${handOff}\nprintf '%s' "$TIMINGS"`, { E2E_SHARD_TIMINGS: handed });
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

test('the committed timings plan fifteen memory shards close to an even split @scenario:pr-memory-shards-finish-balanced', () => {
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

test('recorded timings reach every shard as the one copy the run resolved @scenario:recorded-timings-reach-every-shard-as-one-copy', () => {
  const dir = scratch();
  try {
    // A cache entry as the recorder writes it, with one value no plan can use.
    const recorded = { ...FIXTURE_TIMINGS, 'scenarios/recorded-0.spec.ts': 400 };
    const handed = resolved(
      dir,
      JSON.stringify({ files: { ...recorded, 'scenarios/gone.spec.ts': 'slow' } }, null, 2),
    );
    const timings = resolve(dir, shardTimings(dir, handed));
    expect(JSON.parse(readFileSync(timings, 'utf8'))).toEqual({ files: recorded });
    const { shards, estimates } = planAll(dir, { files: FIXTURE, timings });
    expectExactCover(shards, Object.keys(FIXTURE));
    // The fixture's own timings put that spec at 5 s; the recorded 400 s is what was balanced.
    expect(Math.max(...estimates), `per-shard estimates ${estimates.join(' ')}`).toBe(400);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recorded timings that cannot be read leave every shard on the committed file @scenario:unreadable-recorded-timings-fall-back-to-the-committed-file', () => {
  const unreadable = [
    undefined,
    '',
    '{not json',
    '[]',
    '{"files":[1]}',
    '{"files":{}}',
    '{"files":{"a.spec.ts":"slow"}}',
  ];
  for (const cached of unreadable) {
    const dir = scratch();
    try {
      const handed = resolved(dir, cached);
      expect(handed, String(cached)).toBe('');
      expect(shardTimings(dir, handed), String(cached)).toBe('e2e/timings.mock.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
        'playwright-report-memory-1-of-15': [['a.spec.ts', [10000]]],
        'playwright-report-memory-2-of-15': [['b.spec.ts', [4000, 2000]]],
      },
      'run-2': {
        'playwright-report-memory-1-of-15': [['b.spec.ts', [3000]]],
        'playwright-report-memory-2-of-15': [['a.spec.ts', [20000]]],
      },
      'run-3': {
        'playwright-report-memory-1-of-15': [['a.spec.ts', [30000]]],
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
