import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * Every tab of a browser sends the same refresh cookie, so tabs that refresh together present a
 * token one of them is replacing. The mock harness runs its backend with `NODE_ENV=CI`, where the
 * refresh route never reads the session store, so these scenarios read their verdicts from one
 * run of the refresh handler spec. It drives the real handler and session methods against a
 * database, with the tabs' shared cookie modeled as one jar that each response updates.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'src/auth/localRefresh.spec.ts';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const TABS = 'local refresh shared by several tabs';

let report: JestAssertion[] | undefined;

/**
 * Runs the handler spec once per worker and keeps every verdict it reports. The run is bounded on
 * its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the
 * scenario even when every assertion passed, as a suite-level error does.
 */
function handlerResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'packages/api'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  const stdout = result.stdout ?? '';
  const output = `${stdout}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`jest did not pass (${result.error?.message ?? result.status}):\n${output}`);
  }
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`jest printed no JSON report:\n${output}`);
  }
  const parsed = JSON.parse(stdout.slice(start)) as JestReport;
  report = parsed.testResults.flatMap((file) => file.assertionResults);
  return report;
}

const expectPassed = (title: string) => {
  const fullName = `${TABS} ${title}`;
  const assertion = handlerResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no refresh spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('session refresh from several tabs', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(330_000);
  });

  test('a tab refreshing with the token another tab just replaced stays signed in @scenario:refresh-replaced-token-stays-signed-in', () => {
    expectPassed('serves a tab whose refresh carries the token another tab just rotated');
  });

  test('tabs refreshing at the same instant stay signed in and keep a cookie that refreshes @scenario:refresh-simultaneous-tabs-stay-signed-in', () => {
    expectPassed(
      'lets one of two simultaneous refreshes rotate, so the stored token matches the cookie',
    );
  });

  test('a slow refresh whose token two later refreshes replaced stays signed in @scenario:refresh-slow-tab-stays-signed-in', () => {
    expectPassed('serves a slow refresh whose token two later refreshes have replaced since');
  });

  test('a replaced token is refused once the grace window has passed @scenario:refresh-replaced-token-expires', () => {
    expectPassed('refuses the replaced token once the grace window has passed');
  });

  test('REFRESH_TOKEN_GRACE_MS=0 refuses a replaced token at once @scenario:refresh-grace-disabled', () => {
    expectPassed('refuses the replaced token at once when REFRESH_TOKEN_GRACE_MS is 0');
  });

  test('a logout that carries the token another tab just replaced still ends the session @scenario:refresh-logout-replaced-token-ends-session', () => {
    expectPassed('ends the session for a logout that carries the token another tab just replaced');
  });

  test('a replaced token does not outlive a revoked session, whenever the revocation lands @scenario:refresh-revoked-session-refused', () => {
    expectPassed('refuses the replaced token after the session was revoked');
    expectPassed('refuses a replaced token whose session is revoked after the lookup');
    expectPassed('refuses a refresh that lost the rotation to a revocation');
  });
});
