import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * An administrator adds a member to a role, or an OpenID login syncs an account into it, while
 * another administrator deletes the role. Whichever commits last, no account is left holding the
 * name of a role that is gone: the deletion moves an account assigned before the delete to USER
 * and audits it, and an assignment that commits after it reads the role back and undoes itself.
 *
 * Those interleavings cannot be timed through the live backend, so the verdicts come from one run
 * of the specs that drive them over real collections: the data-schemas role methods, and the admin
 * role handlers and the IdP role write wired to the methods the routes use.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const RUNS = {
  methods: { cwd: 'packages/data-schemas', specs: ['src/methods/role.methods.spec.ts'] },
  handlers: {
    cwd: 'packages/api',
    specs: ['src/admin/roles.integration.spec.ts', 'src/auth/openidRoleSync.integration.spec.ts'],
  },
};
type Run = keyof typeof RUNS;

const DELETE = 'deleteRoleByName';
const PARTITION = 'role-name-keyed operations stay in the caller tenant partition';
const ADMIN_RACE = 'adding a member to a role while it is deleted';
const IDP_WRITE = 'writeIdpRoleChange against MongoDB';

const reports = new Map<Run, JestAssertion[]>();

/**
 * Runs one workspace's specs once per worker and keeps every verdict they report. The run is
 * bounded on its own, since a synchronous child blocks the test timeout, and a nonzero exit fails
 * the scenario even when every assertion passed, as a suite-level error does.
 */
function results(run: Run): JestAssertion[] {
  const cached = reports.get(run);
  if (cached) {
    return cached;
  }
  const { cwd, specs } = RUNS[run];
  const result = spawnSync(JEST, [...specs, '--json', '--maxWorkers=1', '--coverage=false'], {
    cwd: resolve(repoRoot, cwd),
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
  const assertions = parsed.testResults.flatMap((file) => file.assertionResults);
  reports.set(run, assertions);
  return assertions;
}

const expectPassed = (run: Run, fullName: string) => {
  const assertion = results(run).find((entry) => entry.fullName === fullName);
  expect(assertion, `no spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('assigning a role while it is deleted', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(330_000);
  });

  test('a member added while the role is deleted ends on USER and the deletion audits the move @scenario:role-delete-moves-member-added-mid-delete', () => {
    expectPassed(
      'handlers',
      `${ADMIN_RACE} an add that commits after the deletion read its members ends on USER, audited by the deletion`,
    );
    expectPassed(
      'methods',
      `${DELETE} moves and reports a member assigned after its last member read, evicting their cache`,
    );
    expectPassed(
      'methods',
      `${DELETE} moves and reports a late member when the delete commits but its acknowledgement is lost`,
    );
  });

  test('adding a member to a role deleted before the add commits answers Role not found and leaves them on a role that exists @scenario:role-add-to-deleted-role-is-undone', () => {
    expectPassed(
      'handlers',
      `${ADMIN_RACE} an add whose role is deleted before its write commits is undone and answers 404`,
    );
    expectPassed(
      'handlers',
      `${ADMIN_RACE} an undone add whose previous role was deleted meanwhile moves the user on to USER`,
    );
    expectPassed(
      'handlers',
      `${ADMIN_RACE} an undone add whose previous role was deleted and recreated under its name meanwhile moves the user on to USER`,
    );
  });

  test('an OpenID login that syncs an account into a role deleted meanwhile fails and keeps its role @scenario:idp-sync-into-deleted-role-is-undone', () => {
    expectPassed(
      'handlers',
      `${IDP_WRITE} takes back a sync into a role deleted before the write, unaudited, and fails the login`,
    );
    expectPassed(
      'handlers',
      `${IDP_WRITE} a sync written between a deletion's last member read and the delete is moved by the deletion`,
    );
    expectPassed('handlers', `${IDP_WRITE} reads the role back in the account's tenant`);
  });

  test("members of a role recreated under the deleted name, or another tenant's role of it, keep it @scenario:role-delete-spares-other-roles-of-the-name", () => {
    expectPassed(
      'methods',
      `${DELETE} leaves the members of a role recreated under the name right after the delete`,
    );
    expectPassed(
      'methods',
      `${PARTITION} moves only the platform role's late members after deleting it, leaving the tenant's`,
    );
  });
});
