import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot } from './lint.helpers';

/**
 * Step 4 of the theme README hands a consumer the `content` globs their Tailwind
 * scans. One of them has to reach this package's published files, because every
 * class the components emit lives there and nowhere in the consumer's own `src`.
 * The glob said `dist/**\/*.js` while tsdown forces `.mjs`/`.cjs`, so it matched
 * nothing: a consumer following the documented setup rendered dialogs, menus and
 * buttons whose utilities were never generated. This reads the glob out of the
 * README rather than restating it, so the documentation and the shipped file
 * names cannot drift apart again.
 */

type ClientManifest = { exports: Record<string, unknown>; files: string[] };

const packageRoot = resolve(repoRoot, 'packages/client');
const readmePath = resolve(packageRoot, 'src/theme/README.md');
const PACKAGE_SPECIFIER = '@librechat/client/';

/** The `content` array of the first fenced block under the Tailwind config step. */
function documentedContentGlobs(): string[] {
  const readme = readFileSync(readmePath, 'utf8');
  const step = readme.indexOf('### 4. Configure Tailwind');
  expect(step, 'the README no longer documents the Tailwind config step').toBeGreaterThan(-1);

  const fence = readme.slice(step).match(/```js\n([\s\S]*?)```/);
  expect(fence, 'the Tailwind config step no longer carries a js code block').not.toBeNull();

  const content = fence![1].match(/content:\s*\[([\s\S]*?)\]/);
  expect(content, 'the documented config no longer declares content globs').not.toBeNull();

  return [...content![1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/** Every built module the export map points into `dist`, conditions and all.
 *  Types and the preset are excluded: a consumer's Tailwind has no class names
 *  to find in a `.d.mts` or in the config it loads as a preset. */
function bundlePaths(exports: unknown): string[] {
  if (typeof exports === 'string') {
    return /^\.\/dist\/.+(?<!\.d)\.(js|mjs|cjs)$/.test(exports) ? [exports] : [];
  }
  if (typeof exports === 'object' && exports !== null) {
    return Object.values(exports).flatMap(bundlePaths);
  }
  return [];
}

test.describe('the documented consumer setup', () => {
  test('the documented consumer config scans the published components @scenario:the-documented-consumer-config-scans-the-published-components', () => {
    test.setTimeout(60_000);

    const globs = documentedContentGlobs();
    const packageGlobs = globs
      .filter((glob) => glob.includes(PACKAGE_SPECIFIER))
      .map((glob) => glob.slice(glob.indexOf(PACKAGE_SPECIFIER) + PACKAGE_SPECIFIER.length));

    expect(
      packageGlobs,
      `no documented content glob reaches ${PACKAGE_SPECIFIER}: ${globs.join(', ')}`,
    ).not.toHaveLength(0);

    const scanned = [
      ...new Set(packageGlobs.flatMap((glob) => globSync(glob, { cwd: packageRoot }))),
    ];

    /** The published entry points are where the class names are: a glob that
     *  misses them leaves the consumer's Tailwind with nothing to find. */
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
    ) as ClientManifest;
    const entryPoints = bundlePaths(manifest.exports).map((entry) => entry.replace(/^\.\//, ''));

    expect(entryPoints, 'the package exports no javascript entry point').not.toHaveLength(0);
    for (const entry of entryPoints) {
      expect(
        scanned,
        `the documented globs (${packageGlobs.join(', ')}) do not match ${entry}; build the package first`,
      ).toContain(entry);
    }

    /** And scanning them is load-bearing: the files carry utility class names
     *  the consumer's own sources never mention. */
    for (const entry of entryPoints) {
      const bundle = readFileSync(resolve(packageRoot, entry), 'utf8');
      expect(bundle, `${entry} carries no theme utility for Tailwind to find`).toContain(
        'bg-surface-primary',
      );
    }
  });
});
