import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { stripVTControlCharacters } from 'node:util';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * The ClickHouse palette spec pins every contrast pair that holds a Click UI
 * value below its WCAG floor. A contributor reruns one failing test by name, and
 * Jest may run the file in any order, so the pinning test must reach the same
 * verdict alone and shuffled. Neither needs the browser: each runs the spec the
 * way a contributor does and reads the verdict.
 */

const clientRoot = resolve(repoRoot, 'packages/client');
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SPEC = 'src/theme/themes/clickhouse.spec.tsx';

/** The harness may force colour, so the verdict is read with the escape codes stripped. */
const runSpec = (args: string[]) => {
  const result = run(JEST, [SPEC, '--maxWorkers=1', '--ci', ...args], { cwd: clientRoot });
  return { ...result, output: stripVTControlCharacters(result.output) };
};

test.describe('the ClickHouse pinned contrast pairs', () => {
  test('the pinning test passes when run alone by name @scenario:clickhouse-pinned-pairs-run-alone', () => {
    inOneProject();
    test.setTimeout(180_000);

    const result = runSpec(['-t', 'pins every pair that sits below its floor']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/Tests:\s+\d+ skipped, 2 passed/);
  });

  test('the palette spec passes in shuffled order @scenario:clickhouse-pinned-pairs-shuffled-order', () => {
    inOneProject();
    test.setTimeout(180_000);

    const result = runSpec(['--randomize', '--seed=16821']);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(
      /keeps control boundaries and rings at the 3:1 floor on every canvas/,
    );
  });
});
