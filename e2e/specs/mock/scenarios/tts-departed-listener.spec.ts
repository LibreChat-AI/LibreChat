import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * Text-to-speech asks a paid provider for every segment it speaks, so a listener who leaves must
 * stop costing requests: automatic playback stops reading the message, read-aloud never starts,
 * and the departure is logged as a disconnect rather than a failure.
 *
 * The mock harness configures no speech provider, and one would change the speech settings every
 * other spec sees, so the verdicts come from one run of the service specs. They serve the real
 * `TTSService` behind Express with real axios, a local provider that records what it is asked to
 * speak, and the message read through the real chunk reader and message cache. The listener
 * leaves at each point it can: before the route reaches the service, while playback waits for
 * more of the message, and during a provider request.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SERVICE = 'TTSService speech for a listener';
const LOOP = 'streamSpeech';

const reports = new Map<string, JestAssertion[]>();

/**
 * Runs `specs` once per worker in `workspace` and keeps every verdict they report. The run is
 * bounded on its own, since a synchronous child blocks the test timeout, and a nonzero exit fails
 * the scenario even when every assertion passed, as a suite-level error does.
 */
function results(workspace: string, specs: string[]): JestAssertion[] {
  const cached = reports.get(workspace);
  if (cached) {
    return cached;
  }
  const result = spawnSync(JEST, [...specs, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, workspace),
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
  reports.set(workspace, assertions);
  return assertions;
}

const expectPassed = (assertions: JestAssertion[], fullName: string) => {
  const assertion = assertions.find((entry) => entry.fullName === fullName);
  expect(assertion, `no spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

const service = (title: string) =>
  expectPassed(
    results('api', ['server/services/Files/Audio/TTSService.disconnect.spec.js']),
    `${SERVICE} ${title}`,
  );

const unit = (fullName: string) =>
  expectPassed(
    results('packages/api', ['src/files/speech.spec.ts', 'src/utils/streams.spec.ts']),
    fullName,
  );

test.describe('text-to-speech for a listener who leaves', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(540_000);
  });

  test('automatic playback stops reading the message and asks for no more speech once the listener leaves @scenario:auto-speech-stops-when-listener-leaves-mid-message', () => {
    service(
      'stops reading the message and asks for no more speech once the listener leaves between segments',
    );
    unit(`${LOOP} stops waiting for new text and reads no more once the client leaves`);
    unit(`${LOOP} asks for no speech for text read after the client left`);
  });

  test('a listener who left before automatic playback started costs no provider request @scenario:auto-speech-skips-provider-for-listener-gone-before-start', () => {
    service('asks for no speech for a listener who left before automatic playback started');
    unit('abortOnClose is already aborted for a response that closed before it was asked');
    unit(`${LOOP} reads nothing and asks for no speech once the client already left`);
  });

  test('a listener who left before read-aloud started costs no provider request @scenario:read-aloud-skips-provider-for-listener-gone-before-start', () => {
    for (const text of ['a short text', 'a long text read in chunks']) {
      service(`asks for no speech for a listener who left before read-aloud of ${text} started`);
    }
  });

  test('a listener who leaves during a provider request is logged as a disconnect @scenario:departed-listener-logged-as-disconnect', () => {
    service('logs a listener who leaves during a provider request as a disconnect, not an error');
    const requests = 'isClientDisconnect with a provider request';
    unit(`${requests} counts a request refused because its client already left as a disconnect`);
    unit(`${requests} counts a request cut off when its client leaves as a disconnect`);
    unit(`${requests} keeps a request canceled for another reason apart from a disconnect`);
  });

  test('a listener who stays hears every segment of the message @scenario:auto-speech-speaks-whole-message-to-listener-who-stays', () => {
    service('speaks every segment of a message in order to a listener who stays');
    unit(`${LOOP} speaks each chunk in order and ends the response with the last one`);
  });

  test('a message that cannot be read or spoken still answers as before @scenario:auto-speech-failures-answer-as-before', () => {
    unit(`${LOOP} answers 500 once the message stays missing`);
    unit(
      `${LOOP} answers 500 when the provider fails before any audio, logging the length but not the text`,
    );
    unit(`${LOOP} keeps the audio already sent when a later chunk fails`);
  });
});
