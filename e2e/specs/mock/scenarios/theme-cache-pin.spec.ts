import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * The theme cache replays resolved variables at boot and is retired only when its version
 * changes, so the resolver output pin in `themeCache.spec.ts` is what tells a contributor that a
 * change to what a theme resolves to needs a `THEME_CACHE_EPOCH` bump. Each scenario makes one
 * such change to a scratch copy of the built bundles, points the client's Jest at the copy, and
 * reads what the pin says. Nothing is written into the tree.
 */

const CLIENT_BUNDLE = resolve(repoRoot, 'packages/client/dist/index.cjs');
/** The provider bundle requires its own chunks, so its whole output directory is copied. */
const PROVIDER_DIST = resolve(repoRoot, 'packages/data-provider/dist');
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const BUMP = /bump THEME_CACHE_EPOCH/;

type Edit = { bundle: 'client' | 'provider'; from: string; to: string };

/** Runs the pin against the built bundles with `edits` applied to scratch copies of them. */
function runPin(edits: Edit[]): { status: number; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'lc-theme-pin-'));
  try {
    const bundles = {
      client: join(scratch, 'client.cjs'),
      provider: join(scratch, 'provider', 'index.js'),
    };
    copyFileSync(CLIENT_BUNDLE, bundles.client);
    cpSync(PROVIDER_DIST, join(scratch, 'provider'), { recursive: true });
    for (const { bundle, from, to } of edits) {
      const source = readFileSync(bundles[bundle], 'utf8');
      if (!source.includes(from)) {
        throw new Error(`The ${bundle} bundle no longer contains: ${from}`);
      }
      writeFileSync(bundles[bundle], source.replace(from, to));
    }
    const config = join(scratch, 'jest.config.cjs');
    writeFileSync(
      config,
      `const base = require(${JSON.stringify(resolve(repoRoot, 'client/jest.config.cjs'))});
module.exports = {
  ...base,
  rootDir: ${JSON.stringify(resolve(repoRoot, 'client'))},
  modulePaths: [${JSON.stringify(resolve(repoRoot, 'node_modules'))}],
  transformIgnorePatterns: [...base.transformIgnorePatterns, ${JSON.stringify(scratch)}],
  testResultsProcessor: undefined,
  moduleNameMapper: {
    ...base.moduleNameMapper,
    '^@librechat/client$': ${JSON.stringify(bundles.client)},
    '^librechat-data-provider$': ${JSON.stringify(bundles.provider)},
  },
};
`,
    );
    return run(
      JEST,
      [
        '--config',
        config,
        '--maxWorkers=1',
        '--ci',
        '--testNamePattern',
        'matches the persisted output',
        'src/Providers/__tests__/themeCache.spec.ts',
      ],
      { cwd: resolve(repoRoot, 'client') },
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

test.describe('the theme cache resolver output pin', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('the current resolver output matches the pin @scenario:theme-pin-current-output-passes', () => {
    const result = runPin([]);
    expect(result.status, result.output).toBe(0);
  });

  test('a fallback that acts only beside another source asks for an epoch bump @scenario:theme-pin-joint-fallback', () => {
    const result = runPin([
      {
        bundle: 'client',
        from: '"rgb-series-8": customColors?.["rgb-text-secondary"] ?? baseColors["rgb-text-secondary"]',
        to: '"rgb-series-8": baseColors["rgb-text-secondary"]',
      },
    ]);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(BUMP);
  });

  test('swapping precedence between sources that share a validator asks for an epoch bump @scenario:theme-pin-shared-validator-precedence', () => {
    const result = runPin([
      {
        bundle: 'client',
        from: '["dialogTitleFontFamily", "displayFontFamily"],',
        to: '["dialogTitleFontFamily", "fontFamily"],\n\t["dialogTitleFontFamily", "displayFontFamily"],',
      },
    ]);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(BUMP);
  });

  test('a shadow role that stops canonicalizing None asks for an epoch bump @scenario:theme-pin-shadow-none-case', () => {
    const result = runPin([
      {
        bundle: 'client',
        from: 'result[key].trim().toLowerCase() === "none"',
        to: 'result[key] === "none"',
      },
    ]);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(BUMP);
  });

  test('narrowing an enum literal asks for an epoch bump @scenario:theme-pin-enum-literal', () => {
    const result = runPin([
      {
        bundle: 'provider',
        from: 'fieldFillStyle: (value) => value === "transparent" || value === "fill"',
        to: 'fieldFillStyle: (value) => value === "fill"',
      },
    ]);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(BUMP);
  });

  test('rejecting a formerly valid switch pair asks for an epoch bump @scenario:theme-pin-joint-rule', () => {
    const result = runPin([
      {
        bundle: 'provider',
        from: 'const minimumHeight = height[1] === "px" ? 4 : .5;',
        to: 'const minimumHeight = height[1] === "px" ? 30 : .5;',
      },
    ]);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(BUMP);
  });
});
