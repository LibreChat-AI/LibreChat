import assert from 'node:assert/strict';

const requiredScenarios = [
  'discord-signed-consent-and-exactly-once',
  'discord-durable-response-and-actor-isolation',
  'discord-dm-selection-ask-and-output',
  'discord-dm-revoke-fences-later-prompts',
  'discord-native-mention-exactly-once',
  'discord-native-thread-actor-lanes',
  'discord-native-dm-selection-and-revoke',
];

/**
 * Signed ingress and native Gateway ingestion need different backend policy, so they run as separate
 * Playwright passes. The gate reads their reports together: a pass that never ran leaves its
 * scenarios missing, and any runner error in either pass fails the lane.
 */
export function mergeDiscordReports(reports) {
  assert.ok(Array.isArray(reports) && reports.length > 0, 'Missing Discord Playwright reports');
  for (const report of reports) {
    assert.ok(Array.isArray(report?.suites), 'Missing Discord Playwright suites');
    assert.ok(Array.isArray(report.errors), 'Missing Discord Playwright error list');
  }
  return {
    errors: reports.flatMap((report) => report.errors),
    suites: reports.flatMap((report) => report.suites),
  };
}

/** A successful Playwright process can still have skipped every opt-in scenario. */
export function assertDiscordResults(report) {
  assert.ok(Array.isArray(report?.suites), 'Missing Discord Playwright suites');
  assert.deepEqual(report.errors, [], 'Discord Playwright reported errors');
  const passed = new Set();
  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        const scenario = spec.title.match(/@scenario:([\w-]+)/)?.[1];
        for (const test of spec.tests ?? []) {
          assert.equal(test.expectedStatus, 'passed', `${scenario}: must execute`);
          assert.equal(test.status, 'expected', `${scenario}: must pass without retries`);
          assert.equal(test.results?.length, 1, `${scenario}: expected one execution`);
          assert.equal(test.results[0].status, 'passed', `${scenario}: did not pass`);
          passed.add(scenario);
        }
      }
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites);
  for (const scenario of requiredScenarios) {
    assert.ok(passed.has(scenario), `Discord scenario was not executed: ${scenario}`);
  }
  return passed.size;
}
