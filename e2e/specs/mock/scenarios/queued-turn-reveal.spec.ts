import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * A queued follow-up drawn as the next turn settles on the server's evidence, not on timing. Two
 * of those states cannot be produced on demand in the browser: a queued sibling the user cancels
 * after the follow-up's admission already left the receipts, and terminal evidence that names a
 * run other than the follow-up's own. The mock backend admits a queued turn the moment its
 * predecessor ends, so a sibling never stays queued long enough to cancel. Both are pinned by the
 * reveal hook's specs, which run it against the real query cache and store; each scenario here
 * reads those verdicts from a single jest run.
 */

type JestAssertion = { ancestorTitles: string[]; title: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'src/hooks/Chat/__tests__/useQueuedTurnReveal.spec.tsx';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SUITE = 'useQueuedTurnReveal';

let report: JestAssertion[] | undefined;

/**
 * Runs the hook's spec once per worker and keeps every verdict it reports. The run is bounded on
 * its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the scenario
 * even when every assertion passed, as a suite-level error does.
 */
function revealResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'client'),
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
  report = parsed.testResults
    .flatMap((file) => file.assertionResults)
    .filter((assertion) => assertion.ancestorTitles.includes(SUITE));
  return report;
}

const expectPassed = (title: string) => {
  const assertion = revealResults().find((entry) => entry.title === title);
  expect(assertion, `no ${SUITE} spec named "${title}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('a queued follow-up shown as the next turn', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('a follow-up drawn again below its own reply clears once its admission is seen and the queued sibling is gone @scenario:queued-turn-settles-after-sibling-leaves', () => {
    expectPassed(
      'settles a claimed turn revealed after its own reply when admission arrives later',
    );
    expectPassed(
      'settles a turn revealed after its own reply once its admission and the queued sibling leave the projection',
    );
  });

  test('a follow-up that has not run yet stays the next turn whatever other runs report @scenario:queued-turn-stays-next-until-it-runs', () => {
    for (const evidence of [
      'the actual predecessor',
      'another request',
      'another response',
      'no response',
      'an unconfirmed admission boundary',
    ]) {
      expectPassed(`keeps admission guarded when terminal evidence describes ${evidence}`);
    }
    for (const boundary of ['a known', 'an unconfirmed']) {
      expectPassed(
        `remembers a sibling admission with ${boundary} boundary after its receipt disappears`,
      );
    }
  });
});
