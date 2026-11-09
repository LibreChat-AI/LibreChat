import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * A host that supplies its own transport drives the whole turn through `useChat`: send, stop,
 * steering and queueing behind the running turn, and the failures it reports. The behavior is
 * pinned by the facade specs in `transport.spec.tsx`, which run the real chat hooks against a
 * fake transport; each scenario here reads one of those specs' verdicts from a single jest run.
 * None of them needs the browser.
 */

type JestAssertion = { ancestorTitles: string[]; title: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'src/hooks/Chat/__tests__/transport.spec.tsx';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');

let report: JestAssertion[] | undefined;

/**
 * Runs the facade block once per worker and keeps every verdict it reports. The run is bounded on
 * its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the scenario
 * even when every assertion passed, as a suite-level error does.
 */
function facadeResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '-t', 'useChat', '--json', '--maxWorkers=2'], {
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
    .filter((assertion) => assertion.ancestorTitles.includes('useChat'));
  return report;
}

const expectPassed = (title: string) => {
  const assertion = facadeResults().find((entry) => entry.title === title);
  expect(assertion, `no facade spec named "${title}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('useChat over a host-supplied transport', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('a sent turn starts through the host transport and its response streams into messages @scenario:usechat-send-streams-through-host-transport', () => {
    expectPassed('sends a turn through the host transport and streams its response into messages');
  });

  test('stop aborts through the host transport and the stopped turn reads ready @scenario:usechat-stop-settles-ready', () => {
    expectPassed('stops the running turn through the host transport and settles it as ready');
  });

  test('steer and queue target the turn useChat started and a second send is refused @scenario:usechat-steer-queue-behind-running-turn', () => {
    expectPassed('steers and queues behind the turn it started, and refuses a second send');
  });

  test('a rejected start surfaces as the chat error @scenario:usechat-rejected-start-is-error', () => {
    expectPassed('reports a rejected start as the chat error');
  });

  test('a stream that fails mid-turn surfaces as the chat error @scenario:usechat-failed-stream-is-error', () => {
    expectPassed('reports a stream that fails mid-turn as the chat error');
  });
});
