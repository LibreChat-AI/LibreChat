import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * Audio and video reach the agents of a conversation that can read them, when a chain, handoff or
 * added conversation puts agents on different providers in one history, and no agent's turn fails
 * on an audio or video part its provider cannot read.
 *
 * The mock harness swaps the model before a request leaves the server, so what each provider
 * receives is read from the encoder specs. They encode an attachment as a turn does, run the
 * agents SDK's projection for each agent and send it through that provider's real streaming
 * request builder, capturing the request instead of answering it. The client spec checks that a
 * turn hands the conversation's other agents to the audio and video encoders.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const CLIENT = 'BaseClient addAudios and addVideos for agents that share the history';
const RUNS = {
  encoders: {
    cwd: 'packages/api',
    args: [
      'src/files/encode/recipients.spec.ts',
      'src/files/encode/audio.spec.ts',
      'src/files/encode/video.spec.ts',
    ],
  },
  client: {
    cwd: 'api',
    args: ['app/clients/specs/BaseClient.test.js', '-t', 'addAudios and addVideos'],
  },
};
type Run = keyof typeof RUNS;

const SHARED = 'audio and video in a history that agents on different providers read';
const AUDIO = 'encodeAndFormatAudios - agents that share the history';
const VIDEO = 'encodeAndFormatVideos - agents that share the history';
const AUDIO_ALONE = 'encodeAndFormatAudios - provider formatting';
const VIDEO_ALONE = 'encodeAndFormatVideos - provider formatting';

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
  const { cwd, args } = RUNS[run];
  const result = spawnSync(JEST, [...args, '--json', '--maxWorkers=1', '--coverage=false'], {
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
  reports.set(run, assertions);
  return assertions;
}

const expectPassed = (run: Run, suite: string, title: string) => {
  const fullName = `${suite} ${title}`;
  const assertion = results(run).find((entry) => entry.fullName === fullName);
  expect(assertion, `no spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('audio and video in a conversation shared by agents on different providers', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(540_000);
  });

  test('a Gemini agent hears its audio and sees its video, and the other agents run without them @scenario:handoff-gemini-keeps-audio-video', () => {
    expectPassed(
      'encoders',
      SHARED,
      'gives a Gemini agent its audio and every other agent the message without it',
    );
    expectPassed(
      'encoders',
      SHARED,
      'gives a Gemini agent its video and every other agent the message without it',
    );
    expectPassed(
      'encoders',
      AUDIO,
      "keeps a Gemini agent's media part whoever else reads the history",
    );
    expectPassed(
      'encoders',
      VIDEO,
      "keeps a Vertex agent's media part whoever else reads the history",
    );
  });

  test('audio and video an OpenRouter agent receives also reach a Gemini agent, and Claude, Bedrock and Responses API agents run without them @scenario:handoff-openrouter-media-reaches-gemini', () => {
    expectPassed(
      'encoders',
      SHARED,
      'gives a Gemini agent the audio an OpenRouter agent hears, and leaves it out for Claude and the Responses API',
    );
    expectPassed(
      'encoders',
      SHARED,
      'gives a Gemini agent the video an OpenRouter agent sees, and leaves it out for Bedrock',
    );
    expectPassed(
      'encoders',
      AUDIO,
      'keeps input_audio when every other agent reads it, has it rewritten or left out',
    );
    expectPassed(
      'encoders',
      VIDEO,
      'keeps video_url when every other agent reads it, has it rewritten or left out',
    );
  });

  test('an OpenAI-compatible agent that cannot read audio or video runs without it instead of failing, and Gemini agents still receive it @scenario:handoff-unreadable-openai-media-left-out', () => {
    expectPassed(
      'encoders',
      SHARED,
      'sends the audio to Gemini agents only when a GPT agent cannot read input_audio',
    );
    expectPassed(
      'encoders',
      AUDIO,
      "sends Gemini's part when an OpenAI-compatible agent cannot read input_audio",
    );
    expectPassed(
      'encoders',
      VIDEO,
      "sends Gemini's part when an OpenAI-compatible agent cannot read video_url",
    );
    expectPassed('encoders', AUDIO, 'reads agents passed as an iterator once for every file');
    expectPassed(
      'client',
      CLIENT,
      'encodes Gemini parts when a chained agent cannot read OpenAI-compatible audio and video',
    );
  });

  test('a custom endpoint configured for audio keeps hearing it beside an OpenRouter agent @scenario:handoff-configured-gateway-keeps-audio', () => {
    expectPassed(
      'encoders',
      SHARED,
      'keeps input_audio for a custom endpoint that lists audio, beside an OpenRouter agent',
    );
    expectPassed(
      'encoders',
      AUDIO,
      'gives a custom endpoint that lists audio its input_audio unless another agent cannot read it',
    );
  });

  test("audio or video over the limit of a Gemini or Vertex agent reading the conversation fails the turn with that provider's reason @scenario:handoff-gemini-reader-media-limits", () => {
    expectPassed(
      'encoders',
      SHARED,
      "refuses audio over a Gemini agent's inline limit, with Gemini's reason",
    );
    expectPassed(
      'encoders',
      AUDIO,
      "refuses audio over a Gemini reader's limit, with Gemini's reason",
    );
    expectPassed(
      'encoders',
      AUDIO,
      "checks no reader's limit for audio the primary agent does not send",
    );
    expectPassed('encoders', VIDEO, "refuses video over a Vertex reader's limit, with its reason");
  });

  test('a conversation with one agent keeps the audio and video parts it sent before @scenario:single-agent-audio-video-unchanged', () => {
    expectPassed(
      'client',
      CLIENT,
      "encodes the primary agent's own parts when no other agent reads the history",
    );
    expectPassed('encoders', AUDIO_ALONE, 'emits a Google media block for google');
    expectPassed(
      'encoders',
      AUDIO_ALONE,
      'emits an OpenAI-compatible input_audio block for openrouter without configuration',
    );
    expectPassed(
      'encoders',
      AUDIO_ALONE,
      'drops the audio for a custom endpoint that is not configured for audio',
    );
    expectPassed(
      'encoders',
      AUDIO_ALONE,
      'emits an input_audio block for a custom endpoint whose config allows audio',
    );
    expectPassed(
      'encoders',
      AUDIO_ALONE,
      'never emits a block for providers without an audio path, even when configured',
    );
    expectPassed('encoders', VIDEO_ALONE, 'emits a Google media block for google');
    expectPassed(
      'encoders',
      VIDEO_ALONE,
      'emits an OpenAI-compatible video_url block for openrouter without configuration',
    );
    expectPassed(
      'encoders',
      VIDEO_ALONE,
      'drops the video for a custom endpoint that is not configured for video',
    );
    expectPassed(
      'encoders',
      VIDEO_ALONE,
      'emits a video_url block for a custom endpoint whose config allows video',
    );
    expectPassed(
      'encoders',
      VIDEO_ALONE,
      'never emits a block for providers without a video path, even when configured',
    );
  });
});
