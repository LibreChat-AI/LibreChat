import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * An endpoint that forwards `{{LIBRECHAT_OPENID_ACCESS_TOKEN}}` in a header gets a current token
 * when the one read at sign-in has expired: the agents chat router asks the OpenID session for it
 * before the turn is accepted, and answers 401 before the turn starts when the session cannot
 * provide one, so the client refreshes its session and retries.
 *
 * The mock harness signs in with a local account and has no identity provider, so the verdicts
 * come from one run of two specs. The route spec drives the real chat router and middleware with
 * the session provider standing in for the IdP-backed session. The session spec drives the real
 * session refresh service, with only the IdP token endpoint answering from a fake.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPECS = [
  'server/routes/agents/__tests__/chat.openidRefresh.spec.js',
  'server/services/OpenIDSessionRefresh.spec.js',
];
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SESSION = 'OpenIDSessionRefresh agent chat model-header refresh';

let report: JestAssertion[] | undefined;

/**
 * Runs both specs once per worker and keeps every verdict they report. The run is bounded on its
 * own, since a synchronous child blocks the test timeout, and a nonzero exit fails the scenario
 * even when every assertion passed, as a suite-level error does.
 */
function results(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [...SPECS, '--json', '--maxWorkers=1'], {
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

const expectPassed = (fullName: string) => {
  const assertion = results().find((entry) => entry.fullName === fullName);
  expect(assertion, `no spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('OpenID access token forwarded by a model endpoint', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(330_000);
  });

  test('a turn after the sign-in access token expired sends a refreshed token to the endpoint @scenario:openid-header-expired-token-refreshed', () => {
    expectPassed(
      'refreshes an expired OpenID access token before / resolves the custom endpoint header',
    );
    expectPassed(
      'refreshes an expired OpenID access token before /resume resolves the custom endpoint header',
    );
    expectPassed(
      `${SESSION} refreshes an expired session access token before the model header resolves`,
    );
  });

  test('a turn whose session can no longer refresh is answered 401 before it starts @scenario:openid-header-unrefreshable-session-401', () => {
    expectPassed('answers 401 before the turn starts when the session can no longer refresh');
    expectPassed(`${SESSION} asks for sign-in when the session no longer holds OpenID tokens`);
  });

  test('a turn on an endpoint that does not forward the token never waits on the session @scenario:openid-header-other-endpoint-unaffected', () => {
    expectPassed(
      'accepts a turn on an endpoint that does not forward the token without the session',
    );
    expectPassed('does not consult the session while the stored access token is current');
  });
});
