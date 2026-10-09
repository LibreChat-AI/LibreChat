import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * A channel triplet in a custom property (`--brand: 255 0 0`) is a colour
 * literal that `rgb(var(--brand))` paints, so the CSS colour gate rejects it
 * outside the theme token sources. A CSS math function is a valid channel, so a
 * triplet written with one is the same literal. Each scenario runs the real
 * scanner over a scratch tree holding one stylesheet; no browser is involved.
 */

const STYLESHEET = 'client/src/scratch.css';

function scanStylesheet(css: string): { status: number; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'lc-css-colors-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'client/src'), { recursive: true });
    mkdirSync(join(root, 'packages/client/src'), { recursive: true });
    copyFileSync(resolve(repoRoot, 'scripts/css-colors.mts'), join(root, 'scripts/css-colors.mts'));
    symlinkSync(resolve(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, STYLESHEET), css);
    return run(process.execPath, [join(root, 'scripts/css-colors.mts')], { cwd: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test.describe('the CSS colour gate', () => {
  test('a custom property triplet written with math functions is rejected @scenario:css-math-channel-triplet-is-rejected', () => {
    inOneProject();
    const result = scanStylesheet(
      ':root {\n  --brand: calc(255) 0 0;\n  --accent: 255 min(100, 50 * 2) 0;\n  --deep: calc(min(100, max(0, 255))) 0 0;\n}\n',
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(`${STYLESHEET}:2 calc(255) 0 0`);
    expect(result.output).toContain(`${STYLESHEET}:3 255 min(100, 50 * 2) 0`);
    expect(result.output).toContain(`${STYLESHEET}:4 calc(min(100, max(0, 255))) 0 0`);
  });

  test('a triplet whose math reads a variable or a length is accepted @scenario:css-math-channel-with-variable-or-unit-is-accepted', () => {
    inOneProject();
    const result = scanStylesheet(
      ':root {\n  --brand: calc(var(--r) * 2) 0 0;\n  --offset: calc(1px + 2px) 0 0;\n}\n',
    );
    expect(result.status, result.output).toBe(0);
  });
});
