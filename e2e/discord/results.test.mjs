import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDiscordResults } from './results.mjs';

function report() {
  return {
    errors: [],
    suites: [
      {
        suites: [
          {
            specs: [
              'discord-signed-consent-and-exactly-once',
              'discord-durable-response-and-actor-isolation',
              'discord-dm-selection-ask-and-output',
              'discord-dm-revoke-fences-later-prompts',
            ].map((scenario) => ({
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

test('accepts all four executed Discord scenarios in nested suites', () => {
  assert.equal(assertDiscordResults(report()), 4);
});

for (const status of ['skipped', 'failed', 'timedOut', 'interrupted']) {
  test(`rejects a ${status} Discord scenario even if the process exits successfully`, () => {
    const result = report();
    result.suites[0].suites[0].specs[3].tests[0].results[0].status = status;
    assert.throws(() => assertDiscordResults(result), /did not pass/);
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
