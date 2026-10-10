import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  run,
  repoRoot,
  lintStdin,
  messagesFor,
  inOneProject,
  designRuleSeverities,
} from './lint.helpers';

/**
 * `@librechat/chat` is the package the chat hooks and components move into. Its
 * boundaries are what make it reusable: the core runs without a UI framework, and
 * nothing in the package reaches back into the app. These scenarios ask the real
 * flat config and the real build whether that holds, before any code has moved in.
 */

const UI_MODULES = [
  'react',
  'react-dom',
  'jotai',
  'recoil',
  '@tanstack/react-query',
  '@librechat/client',
];

/** The forms a source can load a module in; the boundary judges each the same way. */
const FORMS = (specifier: string): string[] => [
  `import x from '${specifier}';\nexport default x;\n`,
  `export * from '${specifier}';\n`,
  `export const load = () => import('${specifier}');\n`,
  `export const load = () => import(\`${specifier}\`);\n`,
  `export const load = () => require('${specifier}');\n`,
  `export type X = typeof import('${specifier}');\n`,
];

/** One row of the boundary table: a file, a specifier, and whether the boundary rejects it. */
type BoundaryRow = { file: string; specifier: string; rejected: boolean };

const CORE = 'packages/chat/src/core/streaming/probe.ts';
const BINDING = 'packages/chat/src/react/probe.ts';
const COMPONENT = 'packages/chat/src/components/Probe.tsx';

/** Every spelling of the `/react` and `/components` entries from a nested core file. */
const ENTRY_SPELLINGS = ['react', 'components'].flatMap((entry) => [
  `../../${entry}`,
  `../../${entry}/`,
  `../../${entry}.ts`,
  `../../${entry}.tsx`,
  `../../${entry}.js`,
  `../../${entry}.mjs`,
  `../../${entry}.cjs`,
  `../../${entry}/index`,
  `../../${entry}/index.js`,
]);

const row = (file: string, rejected: boolean) => (specifier: string) => ({
  file,
  specifier,
  rejected,
});

const CORE_TABLE: BoundaryRow[] = [
  ...ENTRY_SPELLINGS.map(row(CORE, true)),
  ...[
    'react',
    'react/jsx-runtime',
    'react-dom/client',
    'jotai/utils',
    '@tanstack/react-query',
    '@librechat/client',
    '@librechat/chat/react',
    '@librechat/chat/components',
  ].map(row(CORE, true)),
  ...['react', './components/'].map(row('packages/chat/src/index.ts', true)),
  ...['librechat-data-provider', '../types', '../types.js', './react-utils', '../reactive.js'].map(
    row(CORE, false),
  ),
  ...['react', 'jotai', '../core', '../components'].map(row(BINDING, false)),
];

const APP_TABLE: BoundaryRow[] = [BINDING, COMPONENT, CORE].flatMap((file) =>
  [
    '~/store',
    '@librechat/frontend',
    '@librechat/frontend/src/store/filesDialog',
    'recoil',
    '@librechat/chat',
    '@librechat/chat/components',
  ].map(row(file, true)),
);

/**
 * Lints every row in every form through the real flat config in one process, and returns the
 * sources whose verdict differs from the table, so a failure names the spelling that slipped.
 */
function boundaryMismatches(rows: BoundaryRow[]): string[] {
  const sources = rows.flatMap((entry) =>
    FORMS(entry.specifier).map((code) => ({ ...entry, code })),
  );
  const query = `
    const { ESLint } = require('eslint');
    const sources = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    (async () => {
      const eslint = new ESLint({ overrideConfigFile: 'eslint.config.mjs' });
      const verdicts = [];
      for (const source of sources) {
        const [result] = await eslint.lintText(source.code, { filePath: source.file });
        verdicts.push(result.messages.filter((m) => m.ruleId === 'chat/boundary').length);
      }
      process.stdout.write(JSON.stringify(verdicts));
    })();
  `;
  const answered = run(process.execPath, ['-e', query], { input: JSON.stringify(sources) });
  if (answered.status !== 0) throw new Error(`no lint verdicts: ${answered.output}`);
  const verdicts = JSON.parse(answered.stdout) as number[];
  return sources.flatMap((source, index) =>
    verdicts[index] > 0 === source.rejected
      ? []
      : [
          `${source.file}: ${source.code.trim()} should be ${source.rejected ? 'rejected' : 'allowed'}`,
        ],
  );
}

test.describe('the @librechat/chat package boundary', () => {
  test.beforeEach(() => inOneProject());

  test('the chat core rejects a UI framework import @scenario:the-chat-core-rejects-a-ui-framework-import', () => {
    test.setTimeout(180_000);
    expect(boundaryMismatches(CORE_TABLE)).toEqual([]);

    const jsx = lintStdin(
      'packages/chat/src/core/Probe.tsx',
      'export const Probe = () => <div />;\n',
    );
    expect(messagesFor(jsx, 'no-restricted-syntax')).toHaveLength(1);
  });

  test('the chat package rejects an import from the app @scenario:the-chat-package-rejects-an-import-from-the-app', () => {
    test.setTimeout(180_000);
    expect(boundaryMismatches(APP_TABLE)).toEqual([]);
  });

  test('chat components reject literal copy @scenario:chat-components-reject-literal-copy', () => {
    test.setTimeout(120_000);
    const path = 'packages/chat/src/components/Probe.tsx';
    const literal = lintStdin(path, 'export function Probe() {\n  return <p>Hello world</p>;\n}\n');
    expect(messagesFor(literal, 'i18next/no-literal-string')).toHaveLength(1);

    const labels = lintStdin(
      path,
      'export function Probe() {\n  return <button title="Stop generating" aria-label={`Stop generating`} />;\n}\n',
    );
    expect(messagesFor(labels, 'no-restricted-syntax')).toHaveLength(2);
    const props = lintStdin(
      path,
      'export function Probe() {\n  return <img alt="" className="size-4" role="presentation" />;\n}\n',
    );
    expect(messagesFor(props, 'no-restricted-syntax')).toEqual([]);

    const localized = lintStdin(
      path,
      'export function Probe({ label }: { label: string }) {\n  return <p>{label}</p>;\n}\n',
    );
    expect(messagesFor(localized, 'i18next/no-literal-string')).toEqual([]);
  });

  test('the design rules police the chat components @scenario:the-design-rules-police-the-chat-components', () => {
    test.setTimeout(120_000);
    const path = 'packages/chat/src/components/Probe.tsx';
    const severities = designRuleSeverities([path])[path];
    for (const rule of [
      'shadcn/no-restyle',
      'shadcn/no-raw-colors',
      'shadcn/no-arbitrary-values',
      'shadcn/no-inline-styles',
      'shadcn/require-static-classes',
      'shadcn/no-unknown-classes',
    ]) {
      expect(severities[rule], rule).toBe(2);
    }

    const messages = lintStdin(
      path,
      'export function Probe() {\n  return <p className="bg-red-500">x</p>;\n}\n',
    );
    expect(messagesFor(messages, 'shadcn/no-raw-colors').length).toBeGreaterThan(0);
  });
});

test.describe('the built @librechat/chat package', () => {
  test.beforeEach(() => inOneProject());

  test('the chat core loads without React, Jotai or Recoil @scenario:the-chat-core-loads-without-react-jotai-or-recoil', () => {
    test.setTimeout(120_000);
    const dist = resolve(repoRoot, 'packages/chat/dist');
    expect(existsSync(dist), 'packages/chat/dist is missing: run npm run build').toBe(true);

    /** Every UI module fails to resolve in this process, so loading the core
     *  succeeds only when nothing it reaches imports one. */
    const probe = `
      const Module = require('node:module');
      const blocked = new Set(${JSON.stringify(UI_MODULES)});
      const resolveFilename = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (blocked.has(request)) throw new Error('the core reached ' + request);
        return resolveFilename.call(this, request, ...rest);
      };
      const core = require('@librechat/chat');
      const answer = {
        contentTypesText: core.ContentTypes.TEXT,
        toUIMessage: typeof core.toUIMessage,
        react: require.resolve('@librechat/chat/react'),
        components: require.resolve('@librechat/chat/components'),
      };
      import('@librechat/chat').then((esm) => {
        answer.esmToUIMessage = typeof esm.toUIMessage;
        process.stdout.write(JSON.stringify(answer));
      });
    `;
    const loaded = run(process.execPath, ['-e', probe]);
    expect(loaded.status, loaded.output).toBe(0);
    const answer = JSON.parse(loaded.stdout) as Record<string, string>;
    expect(answer.contentTypesText).toBe('text');
    expect(answer.toUIMessage).toBe('function');
    expect(answer.esmToUIMessage).toBe('function');
    expect(answer.react).toBe(resolve(dist, 'react.cjs'));
    expect(answer.components).toBe(resolve(dist, 'components.cjs'));
  });
});
