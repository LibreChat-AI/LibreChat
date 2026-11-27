import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * A model declared text-only, by the agent's switch, its model spec or librechat.yaml, gives that
 * agent `vision: false` in the input the agents SDK receives, for the primary agent and every
 * subagent, while an agent with nothing declared keeps today's input.
 *
 * The mock harness swaps the model before a request leaves the server and the SDK option ships
 * in LibreChat-AI/agents#754, so the declaration is read from the resolver, the agent
 * initializer and the run builder specs in one jest run.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPECS = [
  'src/endpoints/vision.spec.ts',
  'src/agents/__tests__/initialize.test.ts',
  'src/agents/__tests__/run-summarization.test.ts',
];
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');

let report: JestAssertion[] | undefined;

/**
 * Runs the three specs once per worker, limited to the image input suites, and keeps every
 * verdict. A nonzero exit fails the scenario even when every assertion passed.
 */
function results(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(
    JEST,
    [...SPECS, '-t', 'resolveVision|image input declarations', '--json', '--maxWorkers=1'],
    {
      cwd: resolve(repoRoot, 'packages/api'),
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

test.describe('text-only models', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(300_000);
  });

  test('an agent on a model librechat.yaml declares text-only gets vision false in its SDK input, subagents included @scenario:text-only-model-reaches-agent-input', () => {
    expectPassed(
      "initializeAgent: image input declarations declares the agent's model text-only from its entry in the custom endpoint",
    );
    expectPassed(
      'image input declarations passes each agent its own vision, through eager, lazy and graph subagents',
    );
    expectPassed(
      'initializeAgent: image input declarations declares nothing when the configuration says nothing',
    );
  });

  test('the agent switch outranks the model spec, which outranks the model entry and then the endpoint @scenario:text-only-declaration-precedence', () => {
    expectPassed("resolveVision takes the agent's own text-only switch over every declaration");
    expectPassed('resolveVision takes the model spec over the model entry and the endpoint');
    expectPassed("resolveVision takes a custom endpoint model's own entry over the endpoint");
    expectPassed('resolveVision reads the model in its Azure group before the Azure endpoint');
    expectPassed(
      "initializeAgent: image input declarations lets the agent's own text-only switch outrank its spec and endpoint",
    );
  });
});
