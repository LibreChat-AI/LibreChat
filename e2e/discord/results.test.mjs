import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDiscordResults, mergeDiscordReports } from './results.mjs';

const signed = [
  'discord-signed-consent-and-exactly-once',
  'discord-durable-response-and-actor-isolation',
  'discord-dm-selection-ask-and-output',
  'discord-dm-revoke-fences-later-prompts',
];
const native = [
  'discord-native-mention-exactly-once',
  'discord-native-thread-actor-lanes',
  'discord-native-dm-selection-and-revoke',
];

function report(scenarios = [...signed, ...native]) {
  return {
    errors: [],
    suites: [
      {
        suites: [
          {
            specs: scenarios.map((scenario) => ({
              title: `Acceptance @scenario:${scenario}`,
              tests: [
                { expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] },
              ],
            })),
          },
        ],
      },
    ],
  };
}

test('accepts all seven executed Discord scenarios in nested suites', () => {
  assert.equal(assertDiscordResults(report()), 7);
});

for (const status of ['skipped', 'failed', 'timedOut', 'interrupted']) {
  test(`rejects a ${status} Discord scenario even if the process exits successfully`, () => {
    for (const index of [3, 6]) {
      const result = report();
      result.suites[0].suites[0].specs[index].tests[0].results[0].status = status;
      assert.throws(() => assertDiscordResults(result), /did not pass/);
    }
  });
}

test('rejects a missing scenario, an expected failure, retries, and runner errors', () => {
  const missing = report();
  missing.suites[0].suites[0].specs.pop();
  assert.throws(() => assertDiscordResults(missing), /was not executed/);
  const expectedFailure = report();
  expectedFailure.suites[0].suites[0].specs[0].tests[0].expectedStatus = 'failed';
  assert.throws(() => assertDiscordResults(expectedFailure), /must execute/);
  const retried = report();
  retried.suites[0].suites[0].specs[0].tests[0].results.unshift({ status: 'failed' });
  assert.throws(() => assertDiscordResults(retried), /one execution/);
  const errored = report();
  errored.errors.push({ message: 'Setup failed' });
  assert.throws(() => assertDiscordResults(errored), /reported errors/);
  assert.throws(() => assertDiscordResults({}), /Missing/);
});

test('the signed and native passes are gated together, each required', () => {
  assert.equal(assertDiscordResults(mergeDiscordReports([report(signed), report(native)])), 7);
  // A native pass that never ran, or was skipped by a missing opt-in, leaves its scenarios missing.
  assert.throws(
    () => assertDiscordResults(mergeDiscordReports([report(signed)])),
    /was not executed: discord-native-mention-exactly-once/,
  );
  const skipped = report(native);
  skipped.suites[0].suites[0].specs.forEach((spec) => {
    spec.tests[0].expectedStatus = 'skipped';
    spec.tests[0].status = 'skipped';
    spec.tests[0].results = [];
  });
  assert.throws(
    () => assertDiscordResults(mergeDiscordReports([report(signed), skipped])),
    /must execute/,
  );
  // The signed pass is still required when only the native one ran.
  assert.throws(
    () => assertDiscordResults(mergeDiscordReports([report(native)])),
    /was not executed: discord-signed-consent-and-exactly-once/,
  );
});

test('merging carries the runner errors of every pass and rejects malformed reports', () => {
  const errored = report(native);
  errored.errors.push({ message: 'Native setup failed' });
  assert.throws(
    () => assertDiscordResults(mergeDiscordReports([report(signed), errored])),
    /reported errors/,
  );
  assert.throws(() => mergeDiscordReports([]), /Missing Discord Playwright reports/);
  assert.throws(() => mergeDiscordReports([report(signed), {}]), /Missing Discord Playwright/);
  assert.throws(
    () => mergeDiscordReports([report(signed), { suites: [] }]),
    /Missing Discord Playwright error list/,
  );
});
