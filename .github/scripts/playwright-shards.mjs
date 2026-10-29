#!/usr/bin/env node
/**
 * Duration-balanced Playwright shards.
 *
 * `--shard=i/n` cuts the ordered test list into n runs of equal *count*, so a shard that
 * happens to draw the slow, streaming-heavy specs runs minutes longer than one that draws
 * quick visual checks, and the run waits for the slowest. This assigns whole spec files
 * instead, longest first, each to the shard with the least estimated work so far (LPT), using
 * the per-file seconds recorded in the timings file. A file with no recorded time is
 * estimated from its test count at the recorded average per test, so new specs still spread.
 *
 * Every shard computes the same partition from the same inputs (Playwright's own `--list` of
 * the config, the timings file and the reservations), and the shards are disjoint and cover
 * every listed file, so the union is exactly the suite `--shard` would have run.
 *
 *   plan    --list <list.json> --timings <timings.json> --shard <i/n>
 *           [--reserve <i:seconds>[,<i:seconds>...]] [--skip "<specs/mock/a.spec.ts> ..."]
 *           --out <test-list.txt>
 *     Writes the shard's files as a Playwright `--test-list` and prints the plan.
 *     `--reserve` charges a shard for work it does outside this run (extra steps), so the
 *     partition gives it less. `--skip` drops files (paths relative to e2e/) before
 *     partitioning; a skip that would drop every file is ignored.
 *
 *   record  --out <timings.json> <dir-or-results.json>...
 *     Rebuilds the timings file from Playwright JSON reports (`results.json`, written beside
 *     each shard's HTML report in CI). Download a run's `playwright-report-memory-*`
 *     artifacts and point this at them.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Paths in a skip list are relative to `e2e/`; Playwright lists them relative to the testDir. */
const SKIP_PREFIX = 'specs/mock/';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    options[arg.slice(2)] = rest[++i];
  }
  return { command, options };
}

function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!(total >= 1 && index >= 1 && index <= total)) {
    throw new Error(`--shard must look like i/n with 1 <= i <= n; got ${value}`);
  }
  return { index, total };
}

function parseReserve(value, total) {
  const reserve = new Array(total).fill(0);
  for (const entry of (value ?? '').split(',').filter(Boolean)) {
    const match = /^(\d+):(\d+(?:\.\d+)?)$/.exec(entry.trim());
    if (!match || Number(match[1]) < 1 || Number(match[1]) > total) {
      throw new Error(
        `--reserve entries must look like i:seconds with 1 <= i <= ${total}; got ${entry}`,
      );
    }
    reserve[Number(match[1]) - 1] += Number(match[2]);
  }
  return reserve;
}

/** Test count per file from `playwright test --list --reporter=json`, in listing order. */
export function listedFiles(report) {
  if (report.errors?.length) {
    const first = report.errors[0];
    throw new Error(
      `playwright --list reported ${report.errors.length} error(s): ${first.message ?? first}`,
    );
  }
  const counts = new Map();
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      counts.set(file, (counts.get(file) ?? 0) + spec.tests.length);
    }
    for (const child of suite.suites ?? []) {
      walk(child, file);
    }
  };
  for (const suite of report.suites ?? []) {
    counts.set(suite.file, counts.get(suite.file) ?? 0);
    walk(suite, suite.file);
  }
  for (const file of counts.keys()) {
    if (/[>›#]/.test(file) || file !== file.trim()) {
      throw new Error(`cannot express ${JSON.stringify(file)} in a Playwright test list`);
    }
  }
  return counts;
}

/** Seconds for each file: the recorded time, or its test count at the recorded mean. */
export function estimate(counts, timings) {
  let recordedSeconds = 0;
  let recordedTests = 0;
  for (const [file, tests] of counts) {
    if (typeof timings[file] === 'number' && tests > 0) {
      recordedSeconds += timings[file];
      recordedTests += tests;
    }
  }
  const perTest = recordedTests > 0 ? recordedSeconds / recordedTests : 1;
  return new Map(
    [...counts].map(([file, tests]) => [
      file,
      typeof timings[file] === 'number' ? timings[file] : tests * perTest,
    ]),
  );
}

/**
 * Longest-processing-time-first: files in descending estimate (ties by name), each to the
 * least-loaded shard (ties to the lower index). Deterministic for identical inputs.
 */
export function partition(estimates, total, reserve = new Array(total).fill(0)) {
  const loads = [...reserve];
  const shards = Array.from({ length: total }, () => []);
  const ordered = [...estimates].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [file, seconds] of ordered) {
    let target = 0;
    for (let i = 1; i < total; i++) {
      if (loads[i] < loads[target]) {
        target = i;
      }
    }
    shards[target].push(file);
    loads[target] += seconds;
  }
  for (const files of shards) {
    files.sort();
  }
  return { shards, loads };
}

export function applySkip(counts, skip) {
  const names = new Set(
    (skip ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((path) => (path.startsWith(SKIP_PREFIX) ? path.slice(SKIP_PREFIX.length) : path)),
  );
  if (names.size === 0) {
    return { counts, dropped: 0 };
  }
  const kept = new Map([...counts].filter(([file]) => !names.has(file)));
  const dropped = counts.size - kept.size;
  if (dropped === 0 || kept.size === 0) {
    return { counts, dropped: 0 };
  }
  return { counts: kept, dropped };
}

function plan(options) {
  const { index, total } = parseShard(options.shard);
  if (!options.list || !options.timings || !options.out) {
    throw new Error('plan needs --list, --timings and --out');
  }
  const listed = listedFiles(JSON.parse(readFileSync(options.list, 'utf8')));
  if (listed.size === 0) {
    throw new Error('playwright --list found no spec files');
  }
  const timings = JSON.parse(readFileSync(options.timings, 'utf8')).files ?? {};
  const { counts, dropped } = applySkip(listed, options.skip);
  const estimates = estimate(counts, timings);
  const { shards, loads } = partition(estimates, total, parseReserve(options.reserve, total));
  const mine = shards[index - 1];
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, mine.map((file) => `${file}\n`).join(''));
  const unrecorded = [...counts.keys()].filter((file) => typeof timings[file] !== 'number');
  if (dropped) {
    console.log(`codegraph-e2e-skip: dropped ${dropped} graduated specs from this shard's pool`);
  }
  console.log(
    `playwright-shards: shard ${index}/${total} runs ${mine.length} of ${counts.size} files ` +
      `(~${Math.round(loads[index - 1])}s estimated)`,
  );
  if (mine.length === 0) {
    console.log('::warning::this shard drew no spec files; the suite has fewer files than shards');
  }
  console.log(`playwright-shards: estimated seconds per shard: ${loads.map(Math.round).join(' ')}`);
  if (unrecorded.length) {
    console.log(
      `playwright-shards: ${unrecorded.length} file(s) have no recorded time; estimated from test counts`,
    );
  }
}

function findReports(path) {
  if (statSync(path).isDirectory()) {
    return readdirSync(path).flatMap((entry) => findReports(join(path, entry)));
  }
  return path.endsWith('.json') && path.split(/[\\/]/).pop() === 'results.json' ? [path] : [];
}

/** Sum of every attempt's duration per file: what a shard actually spends on it. */
export function fileSeconds(report) {
  const seconds = new Map();
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        for (const result of test.results ?? []) {
          seconds.set(file, (seconds.get(file) ?? 0) + (result.duration ?? 0) / 1000);
        }
      }
    }
    for (const child of suite.suites ?? []) {
      walk(child, file);
    }
  };
  for (const suite of report.suites ?? []) {
    walk(suite, suite.file);
  }
  return seconds;
}

function record(options) {
  if (!options.out || options._.length === 0) {
    throw new Error('record needs --out and at least one report path');
  }
  const totals = new Map();
  const reports = options._.flatMap(findReports);
  for (const path of reports) {
    for (const [file, seconds] of fileSeconds(JSON.parse(readFileSync(path, 'utf8')))) {
      totals.set(file, (totals.get(file) ?? 0) + seconds);
    }
  }
  if (totals.size === 0) {
    throw new Error(`no test results found in ${reports.length} report(s)`);
  }
  const files = Object.fromEntries(
    [...totals]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, s]) => [file, Math.round(s * 10) / 10]),
  );
  writeFileSync(options.out, `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(`playwright-shards: recorded ${totals.size} files from ${reports.length} report(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'plan') {
    plan(options);
  } else if (command === 'record') {
    record(options);
  } else {
    console.error('usage: playwright-shards.mjs plan|record ...');
    process.exit(2);
  }
}
