import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * Removing a shared MCP server, by deleting it or by erasing its owner's account, fences every
 * viewer and tears down their OAuth state. The behavior is pinned by specs that run the real
 * teardown against MongoDB (the token store, its encryption, the ACLs and groups) with only the
 * provider's revocation endpoint replaced; each scenario reads one verdict from a single jest run
 * per workspace. None of them needs the browser.
 */

type JestAssertion = { ancestorTitles: string[]; title: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');

const SUITES = {
  erasure: { cwd: 'packages/api', spec: 'src/user/erasure.spec.ts' },
  cleanup: { cwd: 'packages/api', spec: 'src/mcp/oauth/cleanup.test.ts' },
  route: { cwd: 'api', spec: 'server/controllers/__tests__/mcp.servers.spec.js' },
} as const;

const reports = new Map<keyof typeof SUITES, JestAssertion[]>();

/**
 * Runs a suite once per worker and keeps every verdict it reports. The run is bounded on its own,
 * since a synchronous child blocks the test timeout, and a nonzero exit fails the scenario even
 * when every assertion passed, as a suite-level error does.
 */
function suiteResults(suite: keyof typeof SUITES): JestAssertion[] {
  const cached = reports.get(suite);
  if (cached) {
    return cached;
  }
  const { cwd, spec } = SUITES[suite];
  const result = spawnSync(JEST, [spec, '--json', '--maxWorkers=2'], {
    cwd: resolve(repoRoot, cwd),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240_000,
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
  const assertions = parsed.testResults.flatMap((file) => file.assertionResults);
  reports.set(suite, assertions);
  return assertions;
}

const expectPassed = (suite: keyof typeof SUITES, title: string) => {
  const assertion = suiteResults(suite).find((entry) => entry.title === title);
  expect(assertion, `no ${suite} spec named "${title}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('removing a shared MCP server', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(300_000);
  });

  test('account erasure fences viewers named by the server ACL or a group, token or not @scenario:server-removal-fences-acl-only-viewers', () => {
    expectPassed(
      'erasure',
      'fences viewers who reach the server through its ACL without an OAuth token',
    );
  });

  test('deleting a server fences a viewer who holds no OAuth token @scenario:server-delete-route-fences-acl-only-viewers', () => {
    expectPassed('route', 'fences a viewer who holds no OAuth token when the server is deleted');
  });

  test('a refused provider revocation does not block erasure: local credentials are cleared, the server is removed and the grant is reported @scenario:erasure-surfaces-provider-revocation-failure', () => {
    expectPassed(
      'erasure',
      'removes the server and reports the grant when the provider refuses a revocation',
    );
    expectPassed('cleanup', 'clears local credentials and then rejects in strict mode');
    expectPassed('cleanup', 'returns refused revocations instead of failing the cleanup');
  });

  test('a local token delete failure fails erasure closed and a retry finishes it @scenario:erasure-fails-closed-on-local-teardown-failure', () => {
    expectPassed('erasure', 'fails closed, keeping the server, when a local token delete fails');
    expectPassed('cleanup', 'still fails the cleanup on a local teardown failure');
  });

  test('no authorization or refresh can take the OAuth fence until the server delete commits @scenario:erasure-holds-oauth-fence-through-delete', () => {
    expectPassed('erasure', 'holds every OAuth teardown fence until the server delete commits');
    expectPassed('erasure', 'releases every held fence when a teardown fails locally');
    expectPassed(
      'erasure',
      'keeps the server when a held fence lapsed and another writer took it before the delete',
    );
  });

  test('a user removing their own MCP connection still succeeds when the provider refuses revocation @scenario:own-connection-removal-stays-best-effort', () => {
    expectPassed('cleanup', 'stays best effort for a user removing their own connection');
  });
});
