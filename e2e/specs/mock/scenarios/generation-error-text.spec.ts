import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * A generation that fails outside the model run publishes its error and persists it on the failed
 * turn's error row. These run the resumable controller's own suite for those paths: the real
 * controller and `saveErrorTurn`, with the job store and message writes captured.
 */

const apiRoot = resolve(repoRoot, 'api');

function runControllerTests(pattern: string): void {
  const result = run(
    'npx',
    [
      'jest',
      'server/controllers/agents/__tests__/request.resumeMetadata.spec.js',
      '-t',
      pattern,
      '--maxWorkers=1',
    ],
    { cwd: apiRoot },
  );
  expect(result.status, result.output).toBe(0);
  /** Jest may color the summary, so match the count alone. */
  expect(result.output).toMatch(/(?<!\d)1 passed/);
}

test.describe('generation error text', () => {
  test.beforeEach(() => inOneProject());

  test('under a content policy a raw generation error is published and persisted as the fallback @scenario:generation-error-withheld-under-policy', () => {
    test.setTimeout(300_000);
    runControllerTests('publishes and persists the fallback for a raw generation error');
  });

  test('under a content policy a typed generation error keeps its code for the client @scenario:typed-generation-error-kept', () => {
    test.setTimeout(300_000);
    runControllerTests('keeps a typed generation error under a content policy');
  });

  test('without a content policy a host-authored generation error keeps its wording @scenario:generation-error-kept-without-policy', () => {
    test.setTimeout(300_000);
    runControllerTests('publishes a safe image storage failure during generation');
  });

  test('without a content policy credentials and emails never reach the published or persisted error @scenario:generation-error-secrets-redacted', () => {
    test.setTimeout(300_000);
    runControllerTests('redacts credentials and emails from a generation error');
  });
});
