import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * An attachment reaches every agent of a conversation in a form its own provider reads, when a
 * chain, handoff or added conversation puts agents on different providers or APIs in one history.
 *
 * The mock harness swaps the model before a request leaves the server, so what each provider
 * receives is read from one run of the document specs. They encode an attachment as a turn does,
 * run the agents SDK's projection for each agent and send it through that provider's real
 * streaming request builder, capturing the request instead of answering it.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPECS = ['src/files/encode/recipients.spec.ts', 'src/files/encode/document.spec.ts'];
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SHARED = 'documents in a history that agents on different providers read';
const ENCODER = 'encodeAndFormatDocuments - agents sharing a history';

let report: JestAssertion[] | undefined;

/**
 * Runs the document specs once per worker and keeps every verdict they report. The run is bounded
 * on its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the
 * scenario even when every assertion passed, as a suite-level error does.
 */
function documentResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [...SPECS, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'packages/api'),
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
  report = parsed.testResults.flatMap((file) => file.assertionResults);
  return report;
}

const expectPassed = (suite: string, title: string) => {
  const fullName = `${suite} ${title}`;
  const assertion = documentResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no document spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

const expectHandoff = (primary: string, reader: string) =>
  expectPassed(
    SHARED,
    `sends each provider its own PDF block when a ${primary} agent hands off to a ${reader} agent`,
  );

test.describe('attachments in a conversation shared by agents on different providers', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('a PDF reaches a GPT agent chained after a Claude agent, and the reverse @scenario:handoff-pdf-claude-gpt', () => {
    expectHandoff('Claude', 'GPT');
    expectHandoff('GPT', 'Claude');
  });

  test('a PDF reaches agents on the Responses API and on Chat Completions in one conversation @scenario:handoff-pdf-responses-chat-completions', () => {
    expectHandoff('Responses API', 'Chat Completions');
    expectHandoff('Chat Completions', 'Responses API');
    expectHandoff('Claude', 'Responses API');
  });

  test('Gemini and Bedrock agents read a PDF shared with agents on other providers @scenario:handoff-pdf-gemini-bedrock', () => {
    expectHandoff('Gemini', 'GPT');
    expectHandoff('Claude', 'Gemini');
    expectHandoff('Bedrock', 'Claude');
    expectHandoff('GPT', 'Bedrock');
  });

  test('a text file reaches every agent in the conversation as its text @scenario:handoff-text-file-every-agent', () => {
    expectPassed(SHARED, 'sends every agent the text of a text file');
    expectPassed(
      ENCODER,
      'treats Claude behind an OpenAI-compatible gateway as its own document format',
    );
  });

  test("an attachment one agent's provider cannot read is left out for that agent instead of failing its turn @scenario:handoff-unreadable-type-left-out", () => {
    expectPassed(SHARED, 'leaves a document out for an agent whose provider cannot read its type');
    expectPassed(
      ENCODER,
      'leaves out a binary type a Bedrock agent cannot read and keeps the ones it can',
    );
  });

  test("a document another agent's provider would refuse fails the turn with that provider's reason @scenario:handoff-reader-limits-refused", () => {
    expectPassed(
      SHARED,
      "refuses a PDF that another agent's provider would reject, with that provider's reason",
    );
    expectPassed(
      ENCODER,
      "fails the turn with a reader's reason when a PDF exceeds that reader's limits",
    );
    expectPassed(ENCODER, "checks a Bedrock reader's document limit for the binary types it reads");
    expectPassed(
      ENCODER,
      "checks a reader on the primary agent's own format whose model has a stricter limit",
    );
    expectPassed(ENCODER, "applies a reader's configured size limit to every document type");
    expectPassed(
      ENCODER,
      "refuses a file over a Bedrock reader's limit from its recorded size, without reading it",
    );
  });

  test('agents on one provider and API keep the document blocks they received before @scenario:single-format-documents-unchanged', () => {
    for (const agents of [
      'Claude agents',
      'Chat Completions agents',
      'Responses API agents',
      'Gemini agents',
      'Bedrock agents',
    ]) {
      expectPassed(ENCODER, `keeps the native block when only ${agents} read the history`);
    }
    expectPassed(
      ENCODER,
      'does not count subagents, which never read the history, or agents without a provider',
    );
    expectPassed(
      ENCODER,
      "does not repeat the primary agent's checks for a reader that shares them",
    );
  });
});
