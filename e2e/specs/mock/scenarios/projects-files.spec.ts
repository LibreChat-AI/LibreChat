import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * `projects.files` (and `maxFiles: 0`) governs project reference files apart from `fileConfig`:
 * turned off, nothing is attached and attached files stop reaching chats; otherwise a file must
 * fit the per-file size, the allowed types and the project's storage. These are deployment
 * settings the shared mock harness config does not vary per test, so the verdicts come from one
 * run of the specs that load them: the project routes, the context every chat path resolves,
 * and the project store against MongoDB.
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

const FILES = 'projects.files';

test.describe('Chat Projects file controls', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(200_000);
  });

  test('with project files off nothing is attached and attached files stop reaching chats @scenario:project-files-off', () => {
    expectPassed(store(), `${FILES} refuses every attach with files.enabled: false`);
    expectPassed(store(), `${FILES} refuses every attach with maxFiles: 0`);
    expectPassed(
      api(),
      'resolveChatProjectContext keeps attached files out of the turn with files.enabled: false',
    );
    expectPassed(
      api(),
      'resolveChatProjectContext keeps attached files out of the turn with maxFiles: 0',
    );
    expectPassed(
      api(),
      'ChatProject handlers maps the attach refusal "Project files are turned off" to 403 CHAT_PROJECT_FILES_OFF',
    );
  });

  test('a project file must fit the per-file size and the allowed types @scenario:project-file-size-and-type', () => {
    expectPassed(store(), `${FILES} refuses a file over fileSizeLimit and attaches one under it`);
    expectPassed(store(), `${FILES} refuses a type outside supportedMimeTypes`);
    expectPassed(
      api(),
      'ChatProject handlers maps the attach refusal "Project file too large" to 400 CHAT_PROJECT_FILE_TOO_LARGE',
    );
    expectPassed(
      api(),
      'ChatProject handlers maps the attach refusal "Project file type not allowed" to 400 CHAT_PROJECT_FILE_TYPE',
    );
  });

  test('a project never stores more than totalSizeLimit, also under concurrent attaches @scenario:project-storage-limit', () => {
    expectPassed(
      store(),
      `${FILES} refuses a file that would take the project past totalSizeLimit`,
    );
    expectPassed(store(), `${FILES} keeps concurrent attaches within totalSizeLimit`);
    expectPassed(store(), `${FILES} leaves attaches unchanged when projects.files is unset`);
  });
});
