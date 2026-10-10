import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMCPAppsPhaseResults } from './results.mjs';

const result = (status, expectedStatus = 'passed') => ({
  expectedStatus,
  results: [{ status }],
});
const report = (...tests) => ({
  errors: [],
  suites: [{ suites: [{ specs: [{ tests }] }] }],
});

test('requires the expected number of executed, passing tests for each phase', () => {
  assert.equal(
    assertMCPAppsPhaseResults(
      report(result('passed'), result('passed'), result('skipped', 'skipped')),
      'true',
      2,
    ),
    2,
  );
  assert.equal(assertMCPAppsPhaseResults(report(result('passed')), 'quota', 1), 1);
});

test('rejects skipped-only and missing-test reports even when Playwright exits successfully', () => {
  assert.throws(
    () => assertMCPAppsPhaseResults(report(result('skipped', 'skipped')), 'false', 1),
    /expected at least 1 executed passing tests, got 0/,
  );
  assert.throws(() => assertMCPAppsPhaseResults(report(), 'omitted', 1), /got 0/);
  assert.throws(() => assertMCPAppsPhaseResults({}, 'quota', 1), /missing Playwright JSON results/);
});

test('does not count a skipped test as a passing test on retry', () => {
  assert.throws(
    () => assertMCPAppsPhaseResults(report(result('passed', 'skipped')), 'true', 1),
    /got 0/,
  );
  assert.throws(
    () =>
      assertMCPAppsPhaseResults(
        { ...report(result('passed')), errors: [{ message: 'failed' }] },
        'quota',
        1,
      ),
    /Playwright reported errors/,
  );
});
