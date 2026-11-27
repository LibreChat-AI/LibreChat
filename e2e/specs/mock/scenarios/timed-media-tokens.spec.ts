import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * An audio or video attachment sent to OpenRouter or a custom endpoint configured for media counts
 * toward the context budget by its duration, like the same attachment sent to Gemini, so a long
 * recording is pruned from a request it no longer fits instead of overflowing the provider.
 *
 * The mock harness swaps the model before a request leaves the server, and the budget is computed
 * before the run starts, so it is read from one run of the token counter spec. It counts the parts
 * the audio and video encoders build, compares them with the run's own counter, and runs the agents
 * SDK's pruning on a history whose earlier turn carries a recording.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'src/agents/client.spec.ts';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SUITE = 'countFormattedMessageTokens media blocks';

let report: JestAssertion[] | undefined;

/**
 * Runs the counter suite once per worker and keeps every verdict it reports. The run is bounded on
 * its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the
 * scenario even when every assertion passed, as a suite-level error does.
 */
function counterResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(
    JEST,
    [SPEC, '--json', '--maxWorkers=1', `--testNamePattern=^${SUITE} `],
    {
      cwd: resolve(repoRoot, 'packages/api'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 150_000,
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

const expectPassed = (title: string) => {
  const fullName = `${SUITE} ${title}`;
  const assertion = counterResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no counter spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

const expectBothEncodings = (title: string) => {
  expectPassed(`${title} with o200k_base`);
  expectPassed(`${title} with claude`);
};

test.describe('audio and video in the context budget', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('audio sent to OpenRouter or a custom endpoint counts by its duration, like Gemini audio @scenario:openai-compatible-audio-counted-by-duration', () => {
    expectBothEncodings('counts OpenAI-compatible audio like Gemini media');
  });

  test('video sent to OpenRouter or a custom endpoint counts by its duration, like Gemini video @scenario:openai-compatible-video-counted-by-duration', () => {
    expectBothEncodings('counts an OpenAI-compatible video like Gemini media');
  });

  test('a remote video link or a part without inline data counts the duration fallback @scenario:remote-or-empty-timed-media-counts-fallback', () => {
    expectPassed('counts a remote video link and audio without data at the duration fallback');
  });

  test("the budget for an audio or video part matches the run's own counter @scenario:timed-media-count-matches-run-counter", () => {
    expectBothEncodings('adds what the run token counter adds for the same part');
  });

  test('an earlier recording that no longer fits the window is pruned from the request @scenario:long-recording-pruned-before-request', () => {
    expectPassed('prunes an earlier OpenRouter recording that no longer fits the context window');
  });

  test('Gemini audio, video and PDF media keep their counts @scenario:gemini-media-count-unchanged', () => {
    expectPassed('counts inline audio and video by size');
    expectPassed('counts PDF, audio and video references that carry no inline data');
    expectPassed('counts an inline Google PDF by its estimated page count');
    expectPassed('rejects an oversized Google PDF before invoking the model');
  });
});
