import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * With `OPENID_REUSE_TOKENS`, a refresh that spends a refresh-token grant answers with the ID token
 * that grant issued and keeps the refresh token the identity provider rotated in, the first grant
 * after sign-in included, so the session outlives the sign-in tokens. A provider that keeps the
 * refresh token gets the same answer once the last grant's tokens ran out, even while the answer
 * to that grant still holds its publication open.
 *
 * Token reuse is a process-wide switch, and the mock harness signs in with a local account and has
 * no identity provider, so the verdicts come from one run of the route spec. It signs in through
 * the OpenID callback and refreshes through `/api/auth/refresh` with the real routers, session
 * store, refresh and publication services and their records on a real database, with only the
 * identity provider replaced by one that rotates refresh tokens, or keeps them, and refuses spent
 * ones.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'server/routes/__tests__/auth.openid-refresh.spec.js';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SUITE = 'OpenID token reuse from sign-in through refresh';
const KEPT = 'with a provider that keeps the refresh token';

let report: JestAssertion[] | undefined;

/**
 * Runs the route spec once per worker and keeps every verdict it reports. The run is bounded on
 * its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the
 * scenario even when every assertion passed, as a suite-level error does.
 */
function results(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'api'),
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
  const fullName = `${SUITE} ${title}`;
  const assertion = results().find((entry) => entry.fullName === fullName);
  expect(assertion, `no route spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('OpenID token reuse across sign-in and refresh', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(330_000);
  });

  test('the first refresh after an OpenID sign-in returns the ID token its grant issued @scenario:first-openid-refresh-returns-the-new-id-token', () => {
    expectPassed('answers the first refresh after sign-in with the ID token its grant issued');
  });

  test('an OpenID session keeps refreshing with the refresh token its last grant rotated in @scenario:openid-session-refreshes-with-the-rotated-token', () => {
    expectPassed('refreshes again with the token the first grant rotated in');
  });

  test('with a provider that keeps the refresh token, a refresh after the last grant ran out returns the ID token of its own grant @scenario:non-rotating-openid-refresh-returns-its-own-grant', () => {
    expectPassed(
      `${KEPT} answers a refresh after the last grant ran out with the ID token of its own grant`,
    );
  });

  test('with a provider that keeps the refresh token, tabs that refresh together after the last grant ran out share one grant @scenario:non-rotating-openid-tabs-share-one-grant', () => {
    expectPassed(
      `${KEPT} shares one grant between tabs that refresh together after the last grant ran out`,
    );
  });
});
