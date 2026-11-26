import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * A reasoning effort chosen for an OpenAI or Azure model that runs on Chat Completions reaches the
 * provider as `reasoning_effort` when the model takes one, and stays behind for a model that would
 * reject it, including a summary run on another model.
 *
 * The mock harness swaps the model before a request leaves the server, so what the provider
 * receives is read from one run of the request specs. They build the client options as chat does
 * (`getOpenAIConfig`, or `initializeOpenAI` for a configured Azure group), create the agents SDK's
 * real client and record the request it sends.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPECS = [
  'src/endpoints/openai/requests.spec.ts',
  'src/agents/__tests__/run-summarization.test.ts',
];
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const REQUESTS = 'Chat Completions reasoning effort';
const AZURE = `${REQUESTS} on Azure`;
const SUMMARIES = "summarization reasoning effort on another model of the agent's OpenAI endpoint";

let report: JestAssertion[] | undefined;

/**
 * Runs the request specs once per worker and keeps every verdict they report. The run is bounded
 * on its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the
 * scenario even when every assertion passed, as a suite-level error does.
 */
function requestResults(): JestAssertion[] {
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
  const assertion = requestResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no request spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('reasoning effort on Chat Completions', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('an effort chosen for an o-series or GPT-5 model reaches OpenAI @scenario:chat-completions-effort-reaches-reasoning-models', () => {
    for (const model of ['o3', 'o4-mini', 'gpt-5', 'gpt-5.1', 'gpt-5.5']) {
      expectPassed(REQUESTS, `sends the effort selected for ${model}`);
    }
    expectPassed(
      REQUESTS,
      'sends the effort selected for GPT-5.6 after Chat Completions was chosen',
    );
    expectPassed(REQUESTS, 'sends the selected effort to a gateway on the OpenAI endpoint');
  });

  test('a saved effort stays behind for a model that rejects it @scenario:chat-completions-effort-skips-models-without-effort', () => {
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest']) {
      expectPassed(REQUESTS, `keeps a saved effort away from ${model}, which takes none`);
    }
  });

  test('an effort reaches Azure deployments of reasoning models and deployments that declare efforts @scenario:azure-chat-completions-effort-reaches-deployments', () => {
    expectPassed(AZURE, 'sends the selected effort to a deployment of a reasoning model');
    expectPassed(AZURE, 'sends the selected effort to a deployment that declares its efforts');
    expectPassed(AZURE, 'keeps a saved effort away from a deployment that declares none');
  });

  test('the chosen effort wins over a configured reasoning.effort and drops still remove it @scenario:chat-completions-chosen-effort-precedence', () => {
    expectPassed(REQUESTS, 'sends the effort selected for o3 over a configured reasoning.effort');
    expectPassed(
      REQUESTS,
      'sends the effort selected for gpt-6-sol over a configured reasoning.effort',
    );
    expectPassed(REQUESTS, 'sends a configured reasoning.effort when no effort is selected');
    expectPassed(REQUESTS, 'sends no effort after a reasoning_effort drop');
    expectPassed(REQUESTS, 'sends no configured effort after a reasoning drop');
  });

  test('a summary on another model leaves behind an effort that model rejects @scenario:summary-on-other-model-drops-unsupported-effort', () => {
    expectPassed(
      SUMMARIES,
      'leaves the Chat Completions effort behind for a model that takes none',
    );
    expectPassed(
      SUMMARIES,
      'leaves the Responses reasoning object behind for a model that takes none',
    );
    expectPassed(SUMMARIES, 'keeps the effort for a model that takes one');
  });
});
