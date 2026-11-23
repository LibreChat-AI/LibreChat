import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { collect, render } from './retried.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const reporter = fileURLToPath(new URL('./retried.mjs', import.meta.url));
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const SPEC = `
import { test, expect } from '@playwright/test';

test('steady', () => {
  expect(1).toBe(1);
});

test.describe('group', () => {
  test('recovers \`late\`', ({}, testInfo) => {
    test.skip(process.env.RETRIED_RECOVERS !== 'true');
    expect(testInfo.retry, 'first attempt fails').toBe(1);
  });
});

test('broken', () => {
  test.skip(process.env.RETRIED_BROKEN !== 'true');
  expect(1).toBe(2);
});
`;

const CONFIG = `
export default {
  testDir: '.',
  outputDir: 'results',
  workers: 1,
  retries: 1,
  failOnFlakyTests: process.env.RETRIED_STRICT === 'true',
  reporter: [[process.env.RETRIED_REPORTER]],
};
`;

/** Runs real Playwright over a three-test project and returns its exit, output and job summary. */
function run(t, { strict, recovers = true, broken = false }) {
  const generated = join(root, 'e2e', '.generated');
  mkdirSync(generated, { recursive: true });
  const dir = mkdtempSync(join(generated, 'retried-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'probe.spec.mjs'), SPEC);
  writeFileSync(join(dir, 'playwright.config.mjs'), CONFIG);
  const summary = join(dir, 'summary.md');
  const child = spawnSync(
    process.execPath,
    [cli, 'test', '--config', join(dir, 'playwright.config.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        GITHUB_STEP_SUMMARY: summary,
        RETRIED_REPORTER: reporter,
        RETRIED_STRICT: String(strict),
        RETRIED_RECOVERS: String(recovers),
        RETRIED_BROKEN: String(broken),
      },
    },
  );
  return {
    status: child.status,
    stdout: child.stdout,
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
  };
}

const NAME = /`e2e\/\.generated\/retried-[^/]+\/probe\.spec\.mjs:9 › group › recovers 'late'`/;

test('a retried pass fails a strict run and the job summary says why', (t) => {
  const { status, stdout, summary } = run(t, { strict: true });
  assert.equal(status, 1, stdout);
  assert.match(
    summary,
    /^### Playwright: 1 test passed only on a retry \(playwright\.config\.mjs\)$/m,
  );
  assert.match(summary, NAME);
  assert.match(summary, /: failed, passed\. First error: `Error: first attempt fails`$/m);
  assert.match(summary, /In CI a retried pass fails the run \(`failOnFlakyTests`\)/);
  assert.match(summary, /these retried passes are why the run failed/);
  assert.ok(stdout.includes(summary.trimEnd()), 'the job log carries the same explanation');
  assert.match(stdout, /^ {2}1 flaky$/m, "Playwright's own terminal reporter still runs");
});

test('a retried pass beside a test that failed every attempt is not called the only cause', (t) => {
  const { status, summary } = run(t, { strict: true, broken: true });
  assert.equal(status, 1);
  assert.match(summary, NAME);
  assert.doesNotMatch(summary, /broken/);
  assert.match(summary, /The run failed for other reasons as well/);
});

test('a lenient run passes a retried pass and reports nothing', (t) => {
  const { status, stdout, summary } = run(t, { strict: false });
  assert.equal(status, 0, stdout);
  assert.equal(summary, '');
  assert.doesNotMatch(stdout, /passed only on a retry/);
});

test('a strict run with no retried pass reports nothing', (t) => {
  const clean = run(t, { strict: true, recovers: false });
  assert.equal(clean.status, 0, clean.stdout);
  assert.equal(clean.summary, '');
  const broken = run(t, { strict: true, recovers: false, broken: true });
  assert.equal(broken.status, 1);
  assert.equal(broken.summary, '');
});

/** The fields of a Playwright `TestCase` the reporter reads. */
function testCase({ outcome, titles = ['title'], project = 'chrome', line = 1, results = [] }) {
  return {
    outcome: () => outcome,
    titlePath: () => ['', project, 'file.spec.ts', ...titles],
    location: { file: join(root, 'e2e', 'specs', 'mock', 'file.spec.ts'), line, column: 1 },
    results,
  };
}

const attempt = (status, message) => ({ status, ...(message ? { error: { message } } : {}) });

test('collect keeps retried passes in order and only counts the tests that failed outright', () => {
  const { retried, failed } = collect(
    [
      testCase({ outcome: 'expected', results: [attempt('passed')] }),
      testCase({
        outcome: 'flaky',
        line: 355,
        titles: ['parity', 'late open'],
        results: [
          attempt('timedOut', '\u001b[31mTest timeout of 30000ms exceeded.\u001b[39m'),
          attempt('failed', 'Error: second'),
          attempt('passed'),
        ],
      }),
      testCase({ outcome: 'unexpected', results: [attempt('failed', 'Error: always')] }),
      testCase({ outcome: 'skipped' }),
      testCase({
        outcome: 'flaky',
        project: '',
        results: [
          attempt('failed', `\n\n  Error: ${'x'.repeat(400)}\n    at spec.ts:1`),
          attempt('passed'),
        ],
      }),
    ],
    root,
  );
  assert.equal(failed, 1);
  assert.deepEqual(retried[0], {
    name: '[chrome] › e2e/specs/mock/file.spec.ts:355 › parity › late open',
    attempts: ['timedOut', 'failed', 'passed'],
    error: 'Test timeout of 30000ms exceeded.',
  });
  assert.equal(retried[1].name, 'e2e/specs/mock/file.spec.ts:1 › title');
  assert.equal(retried[1].error, `Error: ${'x'.repeat(233)}…`);
  assert.equal(retried.length, 2);
});

test('render counts in the plural and keeps a title or an error inside its code span', () => {
  const text = render({
    config: 'playwright.config.redis.ts',
    only: true,
    retried: [
      {
        name: 'a.spec.ts:1 › shows `code`\nacross lines',
        attempts: ['failed', 'passed'],
        error: 'a `b` | c',
      },
      { name: 'b.spec.ts:2 › no error', attempts: ['interrupted', 'failed', 'passed'], error: '' },
    ],
  });
  assert.match(
    text,
    /^### Playwright: 2 tests passed only on a retry \(playwright\.config\.redis\.ts\)$/m,
  );
  assert.ok(
    text.includes(
      "- `a.spec.ts:1 › shows 'code' across lines`: failed, passed. First error: `a 'b' | c`\n",
    ),
  );
  assert.ok(text.includes('- `b.spec.ts:2 › no error`: interrupted, failed, passed.\n'));
});
