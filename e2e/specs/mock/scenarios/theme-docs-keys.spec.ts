import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCUMENTED_PATH = resolve(
  __dirname,
  '../../../../packages/data-provider/specs/themedocs.json',
);
const REGISTRY_PATH = resolve(
  __dirname,
  '../../../../packages/data-provider/src/themes/registry.ts',
);

test.describe('theme docs appearance keys', () => {
  test('@scenario:theme-docs-keys-listed lists each documented key once and in the registry', () => {
    const documented = JSON.parse(readFileSync(DOCUMENTED_PATH, 'utf8')) as string[];
    const registry = readFileSync(REGISTRY_PATH, 'utf8');

    expect(documented.length).toBeGreaterThan(0);
    expect(new Set(documented).size).toBe(documented.length);
    const missing = documented.filter((key) => !new RegExp(`\\b${key}\\b`).test(registry));
    expect(missing).toEqual([]);
  });
});
