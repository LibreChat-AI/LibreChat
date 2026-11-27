import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * A request that read a shared link before the link was deleted can still grant on it: the first
 * view of a legacy link migrates its grants, the owner's read restores a missing owner grant, and
 * creating a link grants on the row it just wrote. None of those grants may outlive the link, or a
 * PUBLIC entry is left behind for a link that no longer exists, after an account erasure too.
 *
 * The overlap is a few milliseconds wide in a live server, so the specs place the deletion between
 * each read and its grant: the shared-link service spec runs every writer around every deletion,
 * and the erasure spec runs a whole account erasure, both against MongoDB. Each scenario reads its
 * verdicts from one jest run; none of them needs the browser.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SPECS = [
  'src/shared-links/service.test.ts',
  'src/shared-links/access.test.ts',
  'src/user/erasure.spec.ts',
];

const RACE = 'grants written while their link is deleted';
const ERASURE =
  'eraseUserData leaves no grant on a legacy shared link first viewed while the account is erased';
const DELETIONS = [
  'deleting the link',
  'deleting its conversation',
  'clearing all chats',
  'erasing the account',
];
const BETWEEN = 'leave nothing when written between the erasure cleanup and the link delete';
const GRANTS = [
  'autoMigrateLegacyLink grants OWNER and PUBLIC VIEWER for public legacy link',
  'autoMigrateLegacyLink removes isPublic field from document',
  'autoMigrateLegacyLink grants each principal once when a legacy link is first viewed by concurrent requests',
  'canAccessSharedLink legacy link auto-migration auto-migrates public legacy link and calls next()',
  'ensureLinkPermissions creates OWNER AclEntry for legacy link with no entries',
  'grantCreationPermissions creates OWNER and PUBLIC VIEWER AclEntries',
];
const RETRIES = [
  'deleteAllSharedLinksWithCleanup awaits ACL cleanup and keeps the links when it fails',
  `${RACE} a retried erasure removes what its window left when the sweep after the delete failed`,
];

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERN = [RACE, ERASURE, ...GRANTS, ...RETRIES].map(escape).join('|');

let report: JestAssertion[] | undefined;

/**
 * Runs the specs once per worker, only the tests the scenarios read, and keeps every verdict. The
 * run is bounded on its own, since a synchronous child blocks the test timeout, and a nonzero exit
 * fails the scenario even when every assertion passed, as a suite-level error does.
 */
function results(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [...SPECS, '--json', '--maxWorkers=2', '-t', PATTERN], {
    cwd: resolve(repoRoot, 'packages/api'),
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

const expectPassed = (fullName: string) => {
  const assertion = results().find((entry) => entry.fullName === fullName);
  expect(assertion, `no spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

/** Every timing of one writer: after each deletion ran, and inside the erasure's two cleanups. */
const expectWriterLeavesNothing = (writer: string) => {
  for (const deletion of DELETIONS) {
    expectPassed(`${RACE} from ${writer} leave nothing when written after ${deletion}`);
  }
  expectPassed(`${RACE} from ${writer} ${BETWEEN}`);
};

test.describe('grants written while a shared link is deleted', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(300_000);
  });

  test('deleting an account while its legacy link is first viewed leaves no grant on the link @scenario:account-deletion-leaves-no-grant-on-a-legacy-link', () => {
    expectPassed(ERASURE);
    expectPassed(`${RACE} from the first view of a legacy link ${BETWEEN}`);
    expectPassed(
      `${RACE} from the first view of a legacy link leave nothing when written after erasing the account`,
    );
  });

  test('deleting a legacy link, its chat or all chats while it is first viewed leaves no grant @scenario:deleting-a-legacy-link-mid-view-leaves-no-grant', () => {
    expectWriterLeavesNothing('the first view of a legacy link');
  });

  test('deleting a link while its owner reads it leaves no owner grant @scenario:deleting-a-link-mid-owner-read-leaves-no-grant', () => {
    expectWriterLeavesNothing('the owner reading the link');
  });

  test('deleting a link while it is being created leaves no grant @scenario:deleting-a-link-mid-creation-leaves-no-grant', () => {
    expectWriterLeavesNothing('creating the link');
  });

  test('links that are not being deleted still get their grants @scenario:links-not-being-deleted-keep-their-grants', () => {
    for (const title of GRANTS) {
      expectPassed(title);
    }
  });

  test('an account erasure whose ACL cleanup fails before or after the link delete is finished by its retry @scenario:failed-erasure-cleanup-is-finished-by-retry', () => {
    for (const title of RETRIES) {
      expectPassed(title);
    }
  });
});
