import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * The `projects` block can turn project instructions and descriptions off (a limit of 0) and cap
 * how many projects one user owns. Each is a deployment setting the shared mock harness config
 * does not vary per test, so the verdicts come from one run of the specs that load them: the
 * project routes, the context every chat path resolves, and the project store against MongoDB.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const runs = new Map<string, JestAssertion[]>();

/** Runs one workspace's specs once per worker; a nonzero exit fails the scenario. */
function results(workspace: string, specs: string[]): JestAssertion[] {
  const key = `${workspace}:${specs.join(',')}`;
  const cached = runs.get(key);
  if (cached) {
    return cached;
  }
  const result = spawnSync(JEST, [...specs, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, workspace),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 170_000,
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
  runs.set(key, assertions);
  return assertions;
}

const api = () =>
  results('packages/api', ['src/projects/handlers.spec.ts', 'src/projects/context.spec.ts']);
const store = () => results('packages/data-schemas', ['src/methods/chatProject.spec.ts']);

function expectPassed(assertions: JestAssertion[], fullName: string) {
  const assertion = assertions.find((entry) => entry.fullName === fullName);
  expect(assertion, `no spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
}

const HANDLERS = 'ChatProject handlers turned-off fields and the project cap';
const CAP = 'projects.maxProjectsPerUser';

test.describe('Chat Projects limits', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(200_000);
  });

  test('with maxInstructionsLength 0 no instructions are saved and stored ones never reach a turn @scenario:project-instructions-off', () => {
    expectPassed(api(), `${HANDLERS} refuses a turned-off field on create`);
    expectPassed(api(), `${HANDLERS} refuses a turned-off field on update`);
    expectPassed(
      api(),
      'resolveChatProjectContext keeps stored instructions out of the turn when projects.maxInstructionsLength is 0',
    );
    expectPassed(
      store(),
      'turned-off project fields refuses instructions and drops the description when their limit is 0',
    );
  });

  test('with maxDescriptionLength 0 no description is saved, and clearing one still works @scenario:project-descriptions-off', () => {
    expectPassed(api(), `${HANDLERS} still accepts clearing a turned-off field`);
    expectPassed(
      store(),
      'turned-off project fields refuses instructions and drops the description when their limit is 0',
    );
  });

  test('maxProjectsPerUser refuses the project past the cap, also under concurrent creates @scenario:project-cap-refuses-past-max', () => {
    expectPassed(api(), `${HANDLERS} answers 409 with a stable code when the user is at the cap`);
    expectPassed(store(), `${CAP} refuses the project past the cap and keeps the ones under it`);
    expectPassed(store(), `${CAP} lets concurrent creates fill the cap and no further`);
    expectPassed(store(), `${CAP} counts projects created before the cap was set`);
    expectPassed(store(), `${CAP} frees a place when a project is deleted`);
    expectPassed(store(), `${CAP} gives the same user id its own places in each tenant`);
  });
});
