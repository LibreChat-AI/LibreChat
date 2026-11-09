import path from 'path';
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const VITE_CONFIG = path.join(REPO_ROOT, 'client/vite.config.ts');

/** Loads the real production config and returns the chunk its naming rule picks for each id. */
const PROBE = `
const [configPath, ids] = process.argv.slice(1);
const mod = await import(new URL('file://' + configPath).href);
const config = typeof mod.default === 'function'
  ? mod.default({ command: 'build', mode: 'production' })
  : mod.default;
const group = config.build.rolldownOptions.output.codeSplitting.groups.find(
  (candidate) => typeof candidate.name === 'function',
);
console.log(JSON.stringify(JSON.parse(ids).map((id) => group.name(id))));
`;

function chunkNames(ids: string[]): (string | null)[] {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', PROBE, VITE_CONFIG, JSON.stringify(ids)],
    { cwd: path.join(REPO_ROOT, 'client'), encoding: 'utf8', timeout: 60_000 },
  );
  expect(result.status, result.stderr.slice(-800)).toBe(0);
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]) as (string | null)[];
}

/** One module per rule family, including the rules whose text is a common word. */
const MODULES = [
  'react-dom/index.js',
  'axios/index.js',
  'ky/distribution/index.js',
  'zod/index.js',
  'mermaid/dist/mermaid.core.mjs',
  'remark-gfm/index.js',
  'date-fns/index.js',
  '@radix-ui/react-dialog/dist/index.mjs',
  'katex/dist/katex.mjs',
  '@tanstack/react-query/build/lib/index.mjs',
];

test.describe('vendor chunk rules', () => {
  test('a checkout path never decides which chunk a dependency lands in @scenario:vendor-chunks-ignore-checkout-path', () => {
    const plain = MODULES.map((module) => `/home/dev/LibreChat/node_modules/${module}`);
    const hostile = MODULES.map(
      (module) => `/home/sky/fetch-zod-mermaid-katex/LibreChat/node_modules/${module}`,
    );

    const expected = chunkNames(plain);
    expect(expected).toContain('vendor');
    expect(expected).toContain('http-client');
    expect(expected).toContain('validation');
    expect(chunkNames(hostile)).toEqual(expected);
  });

  test('nested and Windows dependency paths still follow their package @scenario:vendor-chunks-keep-nested-dependencies', () => {
    expect(
      chunkNames([
        '/home/dev/LibreChat/node_modules/mermaid/node_modules/lodash-es/merge.js',
        'C:\\Users\\sky\\fetch\\LibreChat\\node_modules\\react-dom\\index.js',
        'C:\\Users\\sky\\fetch\\LibreChat\\node_modules\\zod\\index.js',
        '/home/sky/fetch/LibreChat/client/src/locales/de/translation.json',
      ]),
    ).toEqual(['mermaid', 'vendor', 'validation', 'locale-de']);
  });

  test('on-demand packages get their own chunks and zod stays with the data layer @scenario:vendor-chunks-keep-on-demand-packages-out-of-vendor', () => {
    expect(
      chunkNames([
        '/home/dev/LibreChat/node_modules/@mcp-ui/client/dist/index.mjs',
        '/home/dev/LibreChat/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-bridge.js',
        '/home/dev/LibreChat/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js',
        '/home/dev/LibreChat/node_modules/html-to-image/es/index.js',
        '/home/dev/LibreChat/node_modules/export-from-json/dist/esm/index.js',
        '/home/dev/LibreChat/node_modules/downloadjs/download.js',
        '/home/dev/LibreChat/node_modules/zod/v4/classic/schemas.js',
      ]),
    ).toEqual([
      'mcp-ui',
      'mcp-apps',
      'mcp-apps',
      'export-tools',
      'export-tools',
      'export-tools',
      'validation',
    ]);
  });
});
