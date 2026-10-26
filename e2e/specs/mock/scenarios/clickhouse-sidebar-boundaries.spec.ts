import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { stripVTControlCharacters } from 'node:util';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * Controls sit on the sidebar as well as the page, the panels and the dialog, so
 * the ClickHouse boundary check measures `surface-sidebar` too. The sidebar holds
 * Click UI's background, so its sub-floor boundary pairs are the page's, pinned by
 * the same owner decision. The check runs the whole spec, so the pinning test
 * compares the pins against the full matrix with the sidebar in it.
 */

const clientRoot = resolve(repoRoot, 'packages/client');
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const SPEC = 'src/theme/themes/clickhouse.spec.tsx';

test.describe('ClickHouse control boundaries on the sidebar', () => {
  test('the boundary and pinning checks hold with the sidebar canvas measured @scenario:clickhouse-sidebar-boundaries-measured', () => {
    inOneProject();
    test.setTimeout(180_000);

    const result = run(JEST, [SPEC, '--maxWorkers=1', '--ci', '--verbose'], { cwd: clientRoot });
    const output = stripVTControlCharacters(result.output);
    expect(result.status, output).toBe(0);
    expect(output.match(/✓ keeps control boundaries and rings at the 3:1 floor/g)).toHaveLength(2);
    expect(output.match(/✓ pins every pair that sits below its floor/g)).toHaveLength(2);
    expect(
      output.match(
        /✓ measures control boundaries on the sidebar, below the floor only in its two/g,
      ),
    ).toHaveLength(2);
  });
});
