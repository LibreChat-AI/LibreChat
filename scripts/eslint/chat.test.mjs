import path from 'node:path';
import { describe, it } from 'node:test';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import chat from './chat.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const root = path.resolve(import.meta.dirname, '../..');
const options = [{ sourceRoot: 'packages/chat/src', packageName: '@librechat/chat' }];
const at = (file) => path.join(root, 'packages/chat/src', file);

const tester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

/** Every spelling a source can use to load one target, in each syntactic form the rule reads. */
const forms = (specifier) => [
  `import x from '${specifier}';`,
  `import type { X } from '${specifier}';`,
  `export * from '${specifier}';`,
  `export { x } from '${specifier}';`,
  `export const load = () => import('${specifier}');`,
  `export const load = () => import(\`${specifier}\`);`,
  `export const load = () => require('${specifier}');`,
  `import x = require('${specifier}');`,
  `export type X = typeof import('${specifier}');`,
];

/** Ways of naming the `/react` and `/components` entries from `src/core/streaming/`. */
const entrySpellings = ['react', 'components'].flatMap((entry) => [
  `../../${entry}`,
  `../../${entry}/`,
  `../../${entry}.ts`,
  `../../${entry}.tsx`,
  `../../${entry}.js`,
  `../../${entry}.mjs`,
  `../../${entry}.cjs`,
  `../../${entry}/index`,
  `../../${entry}/index.js`,
  `../../${entry}/Part.tsx`,
  `../.././${entry}`,
  `../../core/../${entry}`,
]);

const uiSpellings = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'jotai',
  'jotai/utils',
  '@tanstack/react-query',
  '@librechat/client',
  '@librechat/client/theme.css',
];

const appSpellings = [
  '~/store',
  '~',
  '@librechat/frontend',
  '@librechat/frontend/src/store/filesDialog',
  '../../../../client/src/hooks',
  '../../../client/src',
  '../../package.json',
];

const selfSpellings = ['@librechat/chat', '@librechat/chat/react', '@librechat/chat/components'];

const cases = (file, specifiers, messageId) =>
  specifiers.flatMap((specifier) =>
    forms(specifier).map((code) => ({
      code,
      filename: at(file),
      options,
      errors: [{ messageId }],
    })),
  );

const allowed = (file, specifiers) =>
  specifiers.flatMap((specifier) =>
    forms(specifier).map((code) => ({ code, filename: at(file), options })),
  );

tester.run('chat/boundary', chat.rules.boundary, {
  valid: [
    ...allowed('core/streaming/probe.ts', [
      'librechat-data-provider',
      './types',
      '../types.js',
      '../../core/types',
      './react-utils',
      '../reactive.js',
      '../../index',
    ]),
    ...allowed('index.ts', ['./core', './core/index.ts']),
    ...allowed('react/probe.tsx', [
      'react',
      'jotai',
      '@tanstack/react-query',
      '../core',
      '../components',
    ]),
    ...allowed('components/Probe.tsx', ['react', '@librechat/client', '../react']),
    ...allowed('__tests__/core.spec.ts', ['react']),
    {
      code: "const name = 'react'; export const load = () => import(name);",
      filename: at('react/probe.ts'),
      options,
    },
    { code: "import x from '~/store';", filename: path.join(root, 'client/src/x.ts'), options },
  ],
  invalid: [
    ...cases('core/streaming/probe.ts', entrySpellings, 'entry'),
    ...cases('core/streaming/probe.ts', uiSpellings, 'ui'),
    ...cases('index.ts', ['react'], 'ui'),
    ...cases('index.ts', ['./react', './components/'], 'entry'),
    ...cases('core/probe.ts', appSpellings.slice(0, 4), 'app'),
    ...cases('react/probe.ts', appSpellings, 'app'),
    ...cases('components/Probe.tsx', ['recoil', 'recoil/x'], 'recoil'),
    ...cases('react/probe.ts', selfSpellings, 'self'),
    ...cases('core/probe.ts', selfSpellings, 'self'),
    {
      // An absolute root holds when ESLint runs from another directory, as a workspace script does.
      code: "import x from 'react';",
      filename: at('core/probe.ts'),
      options: [
        { sourceRoot: path.join(root, 'packages/chat/src'), packageName: '@librechat/chat' },
      ],
      errors: [{ messageId: 'ui' }],
    },
    {
      code: 'export const load = (name: string) => import(name);',
      filename: at('core/probe.ts'),
      options,
      errors: [{ messageId: 'opaque' }],
    },
    {
      code: 'export const load = (name: string) => require(`./${name}`);',
      filename: at('core/probe.ts'),
      options,
      errors: [{ messageId: 'opaque' }],
    },
  ],
});
