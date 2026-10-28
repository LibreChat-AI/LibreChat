import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * No component renders through `useChat` yet, so what its caller sees is read where the hook
 * runs: the client's jest harness, with the real chat host, stream hook and attachment handler
 * behind a fake transport that streams the run. Each scenario runs the named tests and reads
 * the report jest writes.
 */

type JestReport = {
  numPassedTests: number;
  numFailedTests: number;
  testResults: { assertionResults: { title: string; status: string }[] }[];
};

const runJest = (specs: string[], pattern?: string) => {
  const args = ['jest', ...specs, '--maxWorkers=2', '--json'];
  if (pattern) {
    args.push('-t', pattern);
  }
  const result = run('npx', args, { cwd: resolve(repoRoot, 'client') });
  const start = result.stdout.indexOf('{');
  expect(start, result.output).toBeGreaterThanOrEqual(0);
  return { result, report: JSON.parse(result.stdout.slice(start)) as JestReport };
};

const passedTitles = (report: JestReport) =>
  report.testResults.flatMap((file) =>
    file.assertionResults.filter((item) => item.status === 'passed').map((item) => item.title),
  );

test.describe('useChat live attachments', () => {
  test.beforeEach(() => inOneProject());

  test('a tool part follows an attachment streamed mid-run @scenario:facade-tool-part-follows-live-attachment', () => {
    test.setTimeout(240_000);
    const { result, report } = runJest(
      ['src/hooks/Chat/__tests__/transport.spec.tsx', 'src/hooks/Chat/__tests__/facade.spec.tsx'],
      'attachment streamed mid-run|attachment that reached only the live map',
    );

    expect(result.status, result.output).toBe(0);
    expect(report.numFailedTests).toBe(0);
    expect(passedTitles(report)).toEqual(
      expect.arrayContaining([
        'resolves a tool part against an attachment streamed mid-run',
        'resolves a tool part against an attachment that reached only the live map',
      ]),
    );
  });

  test('the message renderer keeps reconciling stored and live attachments @scenario:message-attachments-merge-live-entries', () => {
    test.setTimeout(240_000);
    const { result, report } = runJest(['src/hooks/Messages/__tests__/useAttachments.spec.tsx']);

    expect(result.status, result.output).toBe(0);
    expect(report.numFailedTests).toBe(0);
    expect(report.numPassedTests).toBeGreaterThan(0);
  });
});
