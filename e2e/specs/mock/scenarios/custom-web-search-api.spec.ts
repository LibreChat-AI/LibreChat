import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * Web search on an OpenAI-compatible custom endpoint reaches the Responses API with OpenAI's
 * `web_search` tool when the API setting is unset, and stays on Chat Completions without the tool
 * after Chat Completions was chosen, so a gateway that only serves Chat Completions still answers.
 *
 * The mock harness swaps the model before a request leaves the server, so the API a request
 * reaches is read from one run of the custom endpoint spec. It loads the endpoint through the
 * librechat.yaml schema, initializes it as chat does, and sends one request through the real
 * OpenAI client to a recording gateway.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'src/endpoints/custom/search.spec.ts';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SUITE = 'OpenAI-compatible custom endpoint web search';

let report: JestAssertion[] | undefined;

/**
 * Runs the endpoint spec once per worker and keeps every verdict it reports. The run is bounded on
 * its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the
 * scenario even when every assertion passed, as a suite-level error does.
 */
function endpointResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '--json', '--maxWorkers=1'], {
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

const expectPassed = (title: string) => {
  const fullName = `${SUITE} ${title}`;
  const assertion = endpointResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no endpoint spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('web search on an OpenAI-compatible custom endpoint', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('a chat that switched the Responses API off keeps web search requests on Chat Completions @scenario:custom-web-search-saved-off-stays-chat-completions', () => {
    expectPassed('stays on Chat Completions after a saved Chat Completions choice');
  });

  test('an endpoint configured for Chat Completions keeps web search requests there @scenario:custom-web-search-configured-off-stays-chat-completions', () => {
    expectPassed('stays on Chat Completions after an addParams override');
    expectPassed('stays on Chat Completions after a customParams default');
    expectPassed('stays on Chat Completions after a useResponsesApi drop');
  });

  test('with the API left unset or switched on, web search reaches the Responses API @scenario:custom-web-search-unset-uses-responses', () => {
    expectPassed('searches through the Responses API when the API is left unset');
    expectPassed(
      'searches through the Responses API when a saved Responses choice overrides the customParams default',
    );
  });
});
