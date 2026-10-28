import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot } from './lint.helpers';

/**
 * A consumer's stylesheet begins `@import '@librechat/client/theme.css'`, so the
 * export has to be a file a bundler can read. It pointed at a directory once,
 * which resolves to nothing and fails at build time in the consumer's project
 * rather than here, hence a scenario that resolves the export the way a bundler
 * does and reads the tokens out of whatever it lands on.
 */

type ClientManifest = {
  exports: Record<string, unknown>;
  files: string[];
};

const packageRoot = resolve(repoRoot, 'packages/client');

test.describe('the published theme stylesheet', () => {
  test('the published token stylesheet resolves as a file @scenario:the-published-token-stylesheet-resolves-as-a-file', () => {
    test.setTimeout(60_000);

    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as ClientManifest;

    const declared = manifest.exports['./theme.css'];
    expect(typeof declared, 'the package must export ./theme.css as a single path').toBe('string');
    const target = resolve(packageRoot, declared as string);

    /** The export is only as good as what it lands on: a directory here is the
     *  regression, and `isFile()` is the difference a consumer feels. */
    const stats = statSync(target, { throwIfNoEntry: false });
    expect(stats, `${declared} does not exist; build the package before publishing`).not.toBe(
      undefined,
    );
    expect(stats!.isFile(), `${declared} resolves to a directory, not a stylesheet`).toBe(true);

    /** And it has to carry the tokens the consumer contract promises, as
     *  `@theme inline` so each utility keeps resolving the custom property the
     *  runtime theme rewrites. */
    const stylesheet = readFileSync(target, 'utf8');
    expect(stylesheet).toContain('@theme inline');
    expect(stylesheet).toContain('--color-text-primary');
    expect(stylesheet).toContain('--color-surface-primary');

    /** `files` decides what ships: an export pointing outside it is dead in the
     *  published tarball even though it resolves in the monorepo. */
    const shipped = manifest.files.some(
      (entry) => target.startsWith(resolve(packageRoot, entry)) || entry === declared,
    );
    expect(
      shipped,
      `${declared} is not inside the published files: ${manifest.files.join(', ')}`,
    ).toBe(true);
    expect(dirname(target).startsWith(packageRoot)).toBe(true);
  });
});
