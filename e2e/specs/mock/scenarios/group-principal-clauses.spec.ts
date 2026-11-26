import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * A member of hundreds of synced Entra groups keeps every permission a group gives them, while
 * ACL, capability and config-override reads send one `$or` clause per principal type instead of
 * one per group. The behavior is pinned by a spec that resolves a user in 300 groups and runs the
 * real reads against MongoDB, counting the clauses each command sends; each scenario reads one
 * verdict from a single jest run. None of them needs the browser.
 */

type JestAssertion = { title: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SPEC = 'src/methods/principal.groups.spec.ts';

let report: JestAssertion[] | undefined;

/**
 * Runs the spec once per worker and keeps every verdict it reports. The run is bounded on its own,
 * since a synchronous child blocks the test timeout, and a nonzero exit fails the scenario even
 * when every assertion passed, as a suite-level error does.
 */
function specResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'packages/data-schemas'),
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
  report = parsed.testResults.flatMap((file) => file.assertionResults);
  return report;
}

const expectPassed = (title: string) => {
  const assertion = specResults().find((entry) => entry.title === title);
  expect(assertion, `no principal spec named "${title}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('permission reads for a member of many groups', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(300_000);
  });

  test('a member of 300 groups opens an agent shared with one of them, checked with one clause per principal type @scenario:group-share-grants-access-in-one-clause', () => {
    expectPassed('resolves every synced group as a principal');
    expectPassed(
      'checks ACL entries with one clause per principal type and still finds a group share',
    );
  });

  test('a capability granted to one of 300 groups applies, checked with one clause per principal type @scenario:group-capability-applies-in-one-clause', () => {
    expectPassed('checks capabilities with one clause per principal type');
  });

  test('a config override for one of 300 groups applies, read with one clause per principal type @scenario:group-config-override-applies-in-one-clause', () => {
    expectPassed('reads config overrides with one clause per principal type');
  });

  test('an ACL entry naming the member id under another type, another group or another role grants nothing @scenario:foreign-principals-grant-nothing', () => {
    expectPassed('matches the same ACL entries as one clause per principal');
  });
});
