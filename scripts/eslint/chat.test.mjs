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
  'client/src/hooks',
  'src/client/src',
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
    ...[
      "import { cn } from '@librechat/client'; export const C = () => cn('a');",
      "import { cn } from '@librechat/client'; export function f() { return cn('a'); }",
      "import { cn } from '@librechat/client'; export const C = memo(function C() { return cn('a'); });",
      "import * as Client from '@librechat/client'; export const C = () => Client.cn('a');",
      "import { cn } from '@librechat/client'; class A { value = cn('a'); }",
      "import type { TShowToast } from '@librechat/client'; export const t = TShowToast;",
      "import { cn } from './utils'; export const classes = cn('a');",
      "import { cn } from '@librechat/client'; const f = (cn: (v: string) => string) => cn('a'); export const x = ((v: string) => v)('a');",
      "import { memo, createContext } from 'react'; export const C = memo(() => null); export const Ctx = createContext(null);",
      "import { atom } from 'jotai'; import { atomFamily } from 'jotai/utils'; export const a = atom(0); export const f = atomFamily(() => a);",
      "import { FileSources } from 'librechat-data-provider'; export const icon = (source: string) => ({ [FileSources.local]: 'x' })[source];",
      "import { FileSources } from 'librechat-data-provider'; export const sources = [FileSources];",
      "import { local } from './sources'; export const icons = { [local.key]: 'x' };",
      "import { Search, cn } from '@librechat/client'; export const icons = { search: Search, cn, list: [Search] };",
      "import { Store } from '@librechat/client'; export const wrapped = wrap(Store); export const alias = Store; export default Store;",
      "import { A, B } from '@librechat/client'; export const pick = flag ? A : B ?? A;",
      "import { Button } from '@librechat/client'; export const element = <Button />;",
      "import { cn } from '@librechat/client'; export { cn };",
      "import { cn } from '@librechat/client'; let join = cn; join = () => ''; export const C = () => join();",
      "import { cn } from '@librechat/client'; export const items = (function* () { yield cn('a'); })();",
      "const { cn } = require('@librechat/client'); export const C = () => cn('a');",
      "const React = require('react'); export const C = React.memo(() => null);",
      "import { cn } from '@librechat/client'; let fn; fn = cn; export const K = class { v = cn('a'); };",
      "import { cn } from '@librechat/client'; export class K { constructor() { cn('a'); } method() { return cn('b'); } }",
      "import { Store } from '@librechat/client'; export interface Derived extends Store {} export class Impl implements Store {} export type S = Store;",
      "import { cn } from '@librechat/client'; export const pick = (on: boolean) => on; export const fn = on ? cn : pick;",
      "import { FileSources } from 'librechat-data-provider'; export const read = () => { const { local } = FileSources; return { ...FileSources, local }; };",
      "import { cn } from '@librechat/client'; export const C = memo((() => cn('a')) as () => string);",
    ].map((code) => ({ code, filename: at('components/Probe.tsx'), options })),
    {
      code: "import { cn } from '@librechat/client'; const classes = cn('a');",
      filename: at('components/__tests__/Probe.spec.tsx'),
      options,
    },
  ],
  invalid: [
    ...cases('core/streaming/probe.ts', entrySpellings, 'entry'),
    ...cases('core/streaming/probe.ts', uiSpellings, 'ui'),
    ...cases('index.ts', ['react'], 'ui'),
    ...cases(
      'core/probe.ts',
      ['components', 'components/Part', 'src/components', 'src/react', '@/react', '@/components/'],
      'entry',
    ),
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
    ...[
      ["import { cn } from '@librechat/client'; export const classes = cn('a');", 'cn'],
      ["import { cn as join } from '@librechat/client'; export const classes = join('a');", 'join'],
      ["import Client from '@librechat/client'; export const classes = Client.cn('a');", 'Client'],
      [
        "import * as Client from '@librechat/client'; export const c = Client['cn']('a');",
        'Client',
      ],
      ["import { cva } from '@librechat/client'; export const variants = cva('a', {});", 'cva'],
      ["import { Store } from '@librechat/client'; export const store = new Store();", 'Store'],
      ["import { css } from '@librechat/client'; export const rule = css`color: red;`;", 'css'],
      ["import { cn } from '@librechat/client'; class A { static value = cn('a'); }", 'cn'],
      ["export const classes = cn('a'); import { cn } from '@librechat/client';", 'cn'],
      ["import { cn } from '@librechat/client'; export const C = memo(() => null, cn('a'));", 'cn'],
      [
        "import { FileSources } from 'librechat-data-provider'; export const icons = { [FileSources.local]: 'x' };",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { Constants } from 'librechat-data-provider'; export const id = Constants.NEW_CONVO.length;",
        'Constants',
        'librechat-data-provider',
      ],
      ["import { v4 } from 'uuid'; export const id = v4();", 'v4', 'uuid'],
      ["import { cn } from '@librechat/client'; export const classes = (() => cn('a'))();", 'cn'],
      ["import { cn } from '@librechat/client'; export const c = (cn as typeof cn)('a');", 'cn'],
      ["import { cn } from '@librechat/client'; export const c = cn!('a');", 'cn'],
      [
        "import { cn } from '@librechat/client'; export const c = ((() => cn('a')) as () => string)();",
        'cn',
      ],
      ["import { Store } from '@librechat/client'; export class Derived extends Store {}", 'Store'],
      ["import { cn } from '@librechat/client'; export const c = (on ? cn : String)('a');", 'cn'],
      ["import { cn } from '@librechat/client'; export const c = (cn || String)('a');", 'cn'],
      [
        "import { cn } from '@librechat/client'; const join = cn; export const c = join('a');",
        'join',
      ],
      [
        "import { cn } from '@librechat/client'; let join; join = cn; export const c = join('a');",
        'join',
      ],
      ["const Client = require('@librechat/client'); export const c = Client.cn('a');", 'Client'],
      ["const { cn } = require('@librechat/client'); export const c = cn('a');", 'cn'],
      ["export const { cn } = require('@librechat/client'); export const c = cn('a');", 'cn'],
      ["import Client = require('@librechat/client'); export const c = Client.cn('a');", 'Client'],
      [
        "import { cn } from '@librechat/client'; export const it = (function* (v = cn('a')) { yield v; })();",
        'cn',
      ],
      [
        "import { cn } from '@librechat/client'; const join = on ? (cn as typeof cn) : String; export const c = join('a');",
        'join',
      ],
      [
        "import { cn } from '@librechat/client'; export const o = new (class { v = cn('a'); })();",
        'cn',
      ],
      [
        "import { cn } from '@librechat/client'; export const o = new (class { constructor() { cn('a'); } })();",
        'cn',
      ],
      [
        "import { cn } from '@librechat/client'; export const v = (on ? () => cn('a') : () => '')();",
        'cn',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; let local; ({ local } = FileSources);",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; export const l = (FileSources ?? {}).local;",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { Store } from '@librechat/client'; export const D = class extends Store {};",
        'Store',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; export const has = 'local' in FileSources;",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { Store } from '@librechat/client'; export const is = ({}) instanceof Store;",
        'Store',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; for (const s of FileSources) {}",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; export const { local } = FileSources;",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; export const all = { ...FileSources };",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; export const all = [...Object.values({}), ...(FileSources as never[])];",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { cn } from '@librechat/client'; export const c = (cn satisfies unknown as typeof cn)('a');",
        'cn',
      ],
      [
        "import * as Client from '@librechat/client'; export const c = (Client as typeof Client).cn('a');",
        'Client',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; export const k = (FileSources as typeof FileSources).local;",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { cn } from '@librechat/client'; export const c = (function () { return cn('a'); })();",
        'cn',
      ],
      [
        "import { FileSources } from 'librechat-data-provider'; export class A { [FileSources.local] = 1; }",
        'FileSources',
        'librechat-data-provider',
      ],
      [
        "import { atom } from 'jotai'; export const a = atom(0);",
        'atom',
        'jotai',
        { loadSafe: [] },
      ],
    ].flatMap(([code, name, source = '@librechat/client', extra = {}]) =>
      ['components/Probe.tsx', 'react/probe.ts'].map((file) => ({
        code,
        filename: at(file),
        options: [{ ...options[0], ...extra }],
        errors: [{ messageId: 'load', data: { name, source } }],
      })),
    ),
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
