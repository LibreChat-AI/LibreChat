import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import type Result from 'lighthouse/types/lhr/lhr.js';

import type { Task } from './lighthouse/measure.mts';
import { discardLighthouseTraces, sanitizeLighthouseArtifacts } from './lighthouse/artifacts.mts';
import { blockingTime, measure, REFERENCE_BENCHMARK_INDEX } from './lighthouse/measure.mts';
import { runLighthouse } from './lighthouse/process.mts';

const blockingBudget = { 'total-blocking-time': 500 };

/** The page under test: two tasks after first paint, 300 ms of blocking at the reference CPU. */
const page: Task[] = [
  { startTime: 400, duration: 600 },
  { startTime: 1500, duration: 250 },
  { startTime: 2500, duration: 150 },
  { startTime: 3500, duration: 30 },
];

/** A run of `tasks` on a runner `slowdown` times slower than the reference. */
function run(tasks: Task[], slowdown = 1, lcp = 3000): Result {
  return {
    environment: { benchmarkIndex: REFERENCE_BENCHMARK_INDEX / slowdown },
    audits: {
      'first-contentful-paint': { numericValue: 1000 * slowdown },
      interactive: { numericValue: 9000 * slowdown },
      'largest-contentful-paint': { numericValue: lcp },
      'main-thread-tasks': {
        details: {
          type: 'table',
          items: tasks.map(({ startTime, duration }) => ({
            startTime: startTime * slowdown,
            duration: duration * slowdown,
          })),
        },
      },
    },
  } as unknown as Result;
}

const slower = (tasks: Task[], factor: number): Task[] =>
  tasks.map(({ startTime, duration }) => ({ startTime, duration: duration * factor }));

test('blocking time at a scale of 1 counts each task tail inside the paint window', () => {
  const tasks = [
    { startTime: 0, duration: 200 },
    { startTime: 900, duration: 300 },
    { startTime: 1500, duration: 150 },
    { startTime: 2000, duration: 40 },
    { startTime: 2900, duration: 300 },
  ];
  assert.equal(blockingTime(tasks, { start: 1000, end: 3000 }), 200 + 100 + 50);
});

test('a runner at any speed measures the same blocking time for the same page', () => {
  const [reference] = measure([run(page)], blockingBudget);
  assert.equal(reference.value, 300);
  for (const slowdown of [0.6, 1.5, 3.6]) {
    const [measured] = measure([run(page, slowdown)], blockingBudget);
    assert.ok(Math.abs(measured.value - 300) < 1e-6, `${slowdown}x measured ${measured.value}`);
  }
});

test('a faster runner counts the tasks that would block at the reference CPU', () => {
  const [measured] = measure([run([{ startTime: 2000, duration: 80 }], 0.5)], blockingBudget);
  assert.ok(Math.abs(measured.value - 30) < 1e-6, `measured ${measured.value}`);
});

test('one busy run cannot fail the blocking budget, and every run over it does', () => {
  const [quiet] = measure([run(slower(page, 3)), run(page), run(slower(page, 2))], blockingBudget);
  assert.equal(quiet.value, 300);
  assert.equal(quiet.statistic, 'lowest, at reference CPU');
  for (const slowdown of [1, 2.5]) {
    const regressed = Array.from({ length: 3 }, () => run(slower(page, 2), slowdown));
    const [measured] = measure(regressed, blockingBudget);
    assert.ok(measured.value > measured.limit, `${slowdown}x measured ${measured.value}`);
  }
});

test('other budgets keep the median, and a report without CPU evidence fails loudly', () => {
  const runs = [run(page, 1, 5200), run(page, 1, 3100), run(page, 1, 4400)];
  assert.deepEqual(measure(runs, { 'largest-contentful-paint': 4500 }), [
    { audit: 'largest-contentful-paint', statistic: 'median', value: 4400, limit: 4500 },
  ]);
  assert.throws(() => measure(runs, { 'speed-index': 1 }), /numeric speed-index for every run/);
  const unmeasured = run(page);
  delete unmeasured.audits['main-thread-tasks'];
  assert.throws(() => measure([unmeasured], blockingBudget), /no main-thread tasks/);
});

test('Lighthouse retains measured trace timings without publishing network logs or cookies', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lighthouse-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cookies = [
    { name: 'refreshToken', value: 'private-token-"quoted"' },
    { name: 'token_provider', value: 'local' },
    { name: 'short_cookie', value: '1' },
  ];
  const header = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  await writeFile(path.join(directory, 'lhr-1-0.devtoolslog.json'), JSON.stringify({ header }));
  await writeFile(
    path.join(directory, 'lhr-1-0.trace.json'),
    JSON.stringify({
      traceEvents: [{ ts: 1231, dur: 51, args: { token: cookies[0].value, header } }],
    }),
  );
  await writeFile(path.join(directory, 'lhr-1.report.html'), header);
  await writeFile(path.join(directory, 'lhr-2-0.trace.json'), '{"partial":"private-token-');
  sanitizeLighthouseArtifacts(directory, cookies);
  assert.ok(!(await readdir(directory)).some((file) => file.endsWith('.devtoolslog.json')));
  assert.ok(!(await readdir(directory)).includes('lhr-2-0.trace.json'));
  const trace = await readFile(path.join(directory, 'lhr-1-0.trace.json'), 'utf8');
  for (const { value } of cookies) {
    assert.ok(!JSON.stringify(JSON.parse(trace).traceEvents[0].args).includes(value));
  }
  assert.equal(JSON.parse(trace).traceEvents[0].ts, 1231);
  assert.equal(JSON.parse(trace).traceEvents[0].dur, 51);
  assert.equal(await readFile(path.join(directory, 'lhr-1.report.html'), 'utf8'), '[redacted]');
});

test('a passing audit discards its traces and keeps its reports', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lighthouse-traces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'lhr-1-0.trace.json'), '{}');
  await writeFile(path.join(directory, 'lhr-1.report.json'), '{}');
  discardLighthouseTraces(directory);
  assert.deepEqual(await readdir(directory), ['lhr-1.report.json']);
});

for (const [failures, diagnostic, stderr] of [
  [0, 'NO_NAVSTART', 'Runtime error encountered: Trace failed (NO_NAVSTART)'],
  [1, 'NO_NAVSTART', 'Runtime error encountered: Trace failed (NO_NAVSTART)'],
  [2, 'NO_NAVSTART', 'Runtime error encountered: Trace failed (NO_NAVSTART)'],
  [2, 'CHROME_CONNECTION_FAILED', 'Unable to connect to Chrome'],
  [2, 'CHROME_PROTOCOL_TIMEOUT', 'Debugger protocol timed out while connecting to Chrome.'],
] as const) {
  test(`Lighthouse reports ${failures} ${diagnostic} attempts without disclosing child payloads`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'lighthouse-process-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cli = path.join(directory, 'cli.cjs');
    const counter = path.join(directory, 'attempts');
    const secret = 'disposable-session-cookie-sentinel';
    const url = 'https://example.test/c/private-conversation';
    await writeFile(
      cli,
      `
      const fs = require('node:fs');
      const counter = ${JSON.stringify(counter)};
      const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
      fs.writeFileSync(counter, String(attempt));
      console.log(${JSON.stringify(secret)});
      console.error(process.argv.join(' '));
      console.error(${JSON.stringify(stderr)});
      process.exit(attempt <= ${failures} ? 1 : 0);
    `,
    );
    const logs: string[] = [];
    t.mock.method(console, 'log', (message: string) => logs.push(message));
    const running = runLighthouse({
      cli,
      flags: [url, `--extra-headers=${JSON.stringify({ Cookie: `refreshToken=${secret}` })}`],
      output: path.join(directory, 'lhr-1'),
      run: 1,
      runs: 3,
    });
    if (failures === 2) {
      await assert.rejects(running, (error: Error) => {
        assert.equal(error.message, `Lighthouse process failed (exit 1, ${diagnostic}).`);
        assert.deepEqual(Object.getOwnPropertyNames(error), ['stack', 'message']);
        assert.ok(!inspect(error).includes(secret));
        assert.ok(!inspect(error).includes(url));
        return true;
      });
    } else {
      await running;
      assert.ok(logs.some((line) => line.endsWith('lhr-1.report.json')));
    }
    assert.equal(Number(await readFile(counter, 'utf8')), Math.min(failures + 1, 2));
    assert.equal(logs.filter((line) => line.includes('retrying')).length, failures === 0 ? 0 : 1);
    for (const line of logs) {
      assert.ok(!line.includes(secret));
      assert.ok(!line.includes(url));
      assert.ok(!line.includes('--extra-headers'));
      assert.ok(!line.includes('Command failed'));
    }
  });
}
