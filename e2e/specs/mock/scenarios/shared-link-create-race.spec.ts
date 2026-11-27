import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * Two tabs, or a double click, can create a link for the same chat at once. Whichever insert
 * reaches the database first, exactly one link is left and every other request answers that the
 * share already exists; a create that fails or is cut short does not block the chat once its
 * link no longer holds the chat's key.
 *
 * The orderings that broke this are a few milliseconds wide and cannot be timed through the live
 * backend, so the verdicts come from one run of the share method specs, which hold an insert or
 * a re-read until another create has moved, against MongoDB. None of them needs the browser.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const CREATE = 'Share Methods createSharedLink';
const OVERLAP = `${CREATE} creates that overlap`;

const RACES = [
  `${CREATE} should leave a single active share when creates race the existence check`,
  `${OVERLAP} keep one share when an earlier-stamped insert lands after a later create finished`,
  `${OVERLAP} refuse a create whose insert lands while another create for the key decides`,
];
const LEFT_CLAIMS = [
  `${OVERLAP} keep a link whose claim could not be released, and free its key once it expires`,
  `${OVERLAP} free a message key whose unreleased claim stayed on a link moved to another message`,
];
const FAILED = `${OVERLAP} leave the next create free after one fails before its insert lands`;
const TARGETED = `${OVERLAP} refuse a whole-conversation share when a message share lands during its insert`;
const INDEX = [
  `${OVERLAP} build the claim index for a collection that lacks it`,
  `${OVERLAP} refuse to create a link while the claim index cannot be built`,
  `${OVERLAP} use a provisioned claim index when the application cannot create indexes`,
];
const SEQUENTIAL = [
  `${CREATE} should create a new shared link`,
  `${CREATE} should throw error if share already exists`,
  `${CREATE} should ignore expired shares when checking for duplicates`,
  `${CREATE} should reject a target message that is not in the owned conversation`,
];

const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERN = [...RACES, ...LEFT_CLAIMS, FAILED, TARGETED, ...INDEX, ...SEQUENTIAL]
  .map((title) => `^${escape(title)}$`)
  .join('|');

let report: JestAssertion[] | undefined;

/**
 * Runs the spec once per worker, only the tests the scenarios read, and keeps every verdict. The
 * run is bounded on its own, since a synchronous child blocks the test timeout, and a nonzero exit
 * fails the scenario even when every assertion passed, as a suite-level error does.
 */
function results(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(
    JEST,
    ['src/methods/share.test.ts', '--json', '--maxWorkers=1', '--coverage=false', '-t', PATTERN],
    {
      cwd: resolve(repoRoot, 'packages/data-schemas'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 240_000,
    },
  );
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

test.describe('creating one shared link from requests that overlap', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(300_000);
  });

  test('creates of a link for one chat at once leave exactly one link and the rest are told it exists @scenario:concurrent-creates-keep-one-link', () => {
    for (const title of RACES) {
      expectPassed(title);
    }
  });

  test('a link left holding its key keeps working and stops blocking new links once it expires or moves to another message @scenario:left-claim-frees-its-key', () => {
    for (const title of LEFT_CLAIMS) {
      expectPassed(title);
    }
  });

  test('a create that fails before its link is written leaves the chat free for the next create @scenario:failed-create-frees-the-chat', () => {
    expectPassed(FAILED);
  });

  test('a whole-chat link is refused when a message link of the chat lands during its create @scenario:whole-chat-link-yields-to-a-message-link', () => {
    expectPassed(TARGETED);
  });

  test('creates build the claim index when automatic indexes are off, use one provisioned for them, and refuse to create a link while it cannot be had @scenario:claim-index-without-auto-indexes', () => {
    for (const title of INDEX) {
      expectPassed(title);
    }
  });

  test('a second link for a shared chat is refused, an expired link does not block a new one, and a missing message is refused @scenario:sequential-share-rules-hold', () => {
    for (const title of SEQUENTIAL) {
      expectPassed(title);
    }
  });
});
