import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * When web search cannot authenticate, the server log names the category, the service and the
 * setting that kept it off, never a value, both on the badge check and on a run that skips the tool.
 *
 * The reason only reaches the server log, which the mock harness cannot read, so the verdicts come
 * from one run of the web search auth spec. It builds each configuration the way the app does (an
 * admin config override through `mergeConfigOverrides`, or `loadWebSearchConfig` for
 * librechat.yaml), resolves it with `loadWebSearchAuth` and reads the debug line that logs.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'src/web/web.spec.ts';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SUITE = 'web.ts authentication gaps';

let report: JestAssertion[] | undefined;

/**
 * Runs the web search auth spec once per worker and keeps every verdict it reports. The run is
 * bounded on its own, since a synchronous child blocks the test timeout, and a nonzero exit fails
 * the scenario even when every assertion passed, as a suite-level error does.
 */
function authResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'packages/api'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 150_000,
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
  const assertion = authResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no web search auth spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('web search authentication gaps in the server log', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('an admin override that leaves the Firecrawl key blank logs that key as not set @scenario:web-search-blank-firecrawl-key-is-named', () => {
    expectPassed('names the Firecrawl key an admin config override left blank');
  });

  test('a required key whose variable is unset is logged with the variable name on the badge check and on a run @scenario:web-search-unset-key-names-its-variable', () => {
    expectPassed(
      'names the variable a required key references when it is unset (throwError: true)',
    );
    expectPassed(
      'names the variable a required key references when it is unset (throwError: false)',
    );
  });

  test('a credential store failure is logged as unreadable rather than as a missing key @scenario:web-search-store-failure-reads-as-unreadable', () => {
    expectPassed('reports a failed credential lookup as unreadable, not as a missing key');
    expectPassed('reports saved selections that could not be read');
  });

  test('a user URL the SSRF check blocks is logged as rejected without the URL @scenario:web-search-blocked-url-logged-without-value', () => {
    expectPassed('reports a user URL the SSRF check blocks as rejected');
  });

  test('a configuration that authenticates logs no gap, and a failed category lists only its own services @scenario:web-search-authenticated-logs-no-gap', () => {
    expectPassed('authenticates the same override once it stores a Firecrawl key');
    expectPassed(
      'lists only the categories that failed, with every service an open category tried',
    );
  });
});
