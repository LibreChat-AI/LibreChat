import { fileURLToPath } from 'node:url';
import path from 'node:path';
import typescriptEslintEslintPlugin from '@typescript-eslint/eslint-plugin';
import { fixupConfigRules, fixupPluginRules } from '@eslint/compat';
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import { plugin as shadcn } from '@shadcn/lint';
import prettier from 'eslint-plugin-prettier';
import { FlatCompat } from '@eslint/eslintrc';
import jsxA11Y from 'eslint-plugin-jsx-a11y';
import i18next from 'eslint-plugin-i18next';
import react from 'eslint-plugin-react';
import jest from 'eslint-plugin-jest';
import globals from 'globals';
import js from '@eslint/js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

const tenantModelRestrictions = [
  {
    selector: "CallExpression[callee.property.name='bulkSave']",
    message:
      'Avoid Model.bulkSave() — it derives writes and delegates to bulkWrite() after running save hooks, but without query middleware to scope the generated write filters. Use create()/insertMany() or tenantSafeBulkWrite() instead.',
  },
  {
    selector: "CallExpression[callee.property.name='watch']",
    message:
      "Avoid Model.watch() — a change stream opens outside query middleware, so the tenant isolation plugin cannot scope it and it emits every tenant's events. A change stream requires a justified inline exemption documenting its system context and explicit tenantId $match guard.",
  },
  {
    selector: "CallExpression[callee.property.name='estimatedDocumentCount']",
    message:
      'Avoid Model.estimatedDocumentCount() — it reads collection metadata and takes no filter, so it always returns the count across every tenant. Use countDocuments() for a tenant-scoped count.',
  },
];

export default [
  {
    ignores: [
      'client/dist/**/*',
      'client/public/**/*',
      'client/coverage/**/*',
      'e2e/playwright-report/**/*',
      'packages/api/types/**/*',
      'packages/api/dist/**/*',
      'packages/api/test_bundle/**/*',
      'api/demo/**/*',
      'packages/client/dist/**/*',
      'packages/data-provider/types/**/*',
      'packages/data-provider/dist/**/*',
      'packages/data-provider/test_bundle/**/*',
      'packages/data-schemas/dist/**/*',
      'data-node/**/*',
      'meili_data/**/*',
      '**/node_modules/**/*',
      'venv/**/*',
      '.devcontainer/**/*',
    ],
  },
  ...fixupConfigRules(
    compat.extends(
      'eslint:recommended',
      'plugin:react/recommended',
      'plugin:react-hooks/recommended',
      'plugin:jest/recommended',
      'prettier',
      'plugin:jsx-a11y/recommended',
    ),
  ),
  {
    plugins: {
      react: fixupPluginRules(react),
      'react-hooks': fixupPluginRules(reactHooks),
      '@typescript-eslint': typescriptEslintEslintPlugin,
      import: importPlugin,
      'jsx-a11y': fixupPluginRules(jsxA11Y),
      'import/parsers': tsParser,
      i18next,
      prettier: fixupPluginRules(prettier),
    },

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.commonjs,
      },
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },

    settings: {
      react: {
        createClass: 'createReactClass',
        pragma: 'React',
        fragment: 'Fragment',
        version: 'detect',
      },
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import/resolver': {
        typescript: {
          project: ['./client/tsconfig.json'],
        },
        node: {
          project: ['./client/tsconfig.json'],
        },
      },
    },

    rules: {
      'prettier/prettier': 'error',
      'react/react-in-jsx-scope': 'off',

      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': false,
        },
      ],
      // Disable a11y features to be enabled later on.
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/alt-text': 'off',
      'jsx-a11y/img-redundant-alt': 'off',
      'jsx-a11y/no-noninteractive-tabindex': 'off',
      // common rules
      'no-nested-ternary': 'error',
      'no-constant-binary-expression': 'warn',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
      // Import cycles are checked by config/circular-deps.mjs over the bundler graph;
      // `import/no-cycle` re-walked that graph from every file (80% of a full-tree lint).
      'import/no-self-import': 'error',
      'import/extensions': 'off',
      'no-promise-executor-return': 'off',
      'no-param-reassign': 'off',
      'no-continue': 'off',
      'no-restricted-syntax': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
    },
  },
  {
    files: ['api/**/*.js', 'config/**/*.js'],
    rules: {
      // API
      'no-async-promise-executor': 'off',
    },
  },
  {
    files: [
      'client/src/**/*.tsx',
      'client/src/**/*.ts',
      'client/src/**/*.jsx',
      'client/src/**/*.js',
    ],
    rules: {
      // Client a11y
      // TODO: maybe later to error.
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'jsx-a11y/label-has-associated-control': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/interactive-supports-focus': 'off',
      'jsx-a11y/no-noninteractive-tabindex': 'off',
      'jsx-a11y/img-redundant-alt': 'off',
    },
  },
  // @shadcn/lint: design-system enforcement for the two client surfaces. The linter treats
  // `@librechat/client` — plus the app-local `~/components/ui` re-exports — as the design
  // system, reads each primitive's cva variants, and reports a className that overrides what
  // the primitive owns, naming the variants and sizes to use instead. The tree's existing
  // violations are recorded in eslint-suppressions.json, so these rules gate new and edited
  // code without a tree-wide migration; see CLAUDE.md, "Theming and styling".
  //
  // The client's entry points and helpers are `.jsx`/`.js` — App.jsx among them — so the globs
  // name those extensions too: the rules have to see them.
  {
    files: ['client/src/**/*.{ts,tsx,js,jsx}', 'packages/client/src/**/*.{ts,tsx,js,jsx}'],
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: '@librechat/client',
        componentImports: ['^~/components/ui(/|$)'],
        note: 'See CLAUDE.md, "Theming and styling".',
      },
    },
    rules: {
      'shadcn/no-restyle': [
        'error',
        {
          // `icon-*` is a sizing utility from client/src/style.css (height, width, stroke-width),
          // so it belongs with layout rather than with a primitive's own appearance.
          allow: ['layout', 'icon-*'],
          // A contract replaces `allow` rather than extending it, so each one restates the
          // baseline. These record policy, not debt: the categories below are the caller's to
          // set, which is why they are not in eslint-suppressions.json.
          contracts: [
            // A text primitive renders the caller's text, so the caller owns its size, weight
            // and leading. Color is still the theme's: it stays reported here.
            {
              pattern: '^(Label|Description|DialogTitle|DialogDescription|SeriesLabel)$',
              allow: ['layout', 'icon-*', 'typography'],
            },
            // A skeleton stands in for the caller's content, so it takes that content's
            // silhouette and footprint.
            { pattern: '^Skeleton$', allow: ['layout', 'icon-*', 'shape', 'spacing'] },
          ],
        },
      ],
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-arbitrary-values': ['error', { allow: ['layout'] }],
      'shadcn/no-inline-styles': [
        'error',
        {
          // Geometry that carries a measured or animated number — a virtual row's height, a
          // floating panel's offset, a drag transform — has no class form. Everything else
          // (color, display, transition, spacing) does, and stays reported.
          allow: [
            'width',
            'height',
            'minWidth',
            'minHeight',
            'maxWidth',
            'maxHeight',
            'top',
            'right',
            'bottom',
            'left',
            'transform',
            'transformOrigin',
            'zIndex',
          ],
        },
      ],
      'shadcn/require-static-classes': 'error',
      // Now answerable: the rule asks the installed Tailwind whether a class generates CSS, and
      // the app is on v4. Classes declared in a stylesheet Tailwind reads are recognized on their
      // own; these are the ones it cannot see, plain selectors in files loaded separately
      // (style.css families, the library's component CSS) and classes a third party puts in the
      // DOM. Everything outside this list that generates no CSS is reported: the `prose` variants
      // that quietly render nothing today, and the `token-`-prefixed names, which were painting
      // through plain rules in `client/src/style.css` that this change removes in favour of the
      // tokens themselves rather than adding six more names here.
      'shadcn/no-unknown-classes': [
        'error',
        {
          allow: [
            // client/src/style.css and the library's component CSS
            'icon-*',
            'hover-button',
            'toast-root',
            'alert-root',
            'tooltip',
            'spinner',
            'popover-ui',
            'select-item',
            'assistant-item',
            'animated-tab',
            'animated-tab-list',
            'animated-tab-panel',
            'animated-panels',
            'animate-popover',
            'animate-popover-bottom',
            'animate-pulse-slow',
            'animate-gradient-x',
            'animate-fadeIn',
            'slow-pulse',
            'hide-scrollbar',
            'scrollbar-gutter-spacer',
            'active',
            // put in the DOM by a dependency, not by Tailwind
            'lucide',
            'lucide-*',
            'language-*',
            'i-heroicons-*',
            'form-check-label',
            // Markers a selector reads rather than Tailwind styling: each one is queried by a
            // stylesheet, a component, or an e2e spec, so it carries no CSS of its own.
            'popover',
            'user-turn',
            'agent-turn',
            'final-completion',
            'sibling-content-group',
            'scroll-animation',
            'hover-button-active',
            'open',
          ],
        },
      ],
    },
  },
  {
    // A primitive owns its own internals, so the rules that police callers are off inside the
    // component library. `no-raw-colors` and `no-inline-styles` stay on: the primitives are
    // where theme tokens matter most. `client/src/components/ui` is deliberately not here:
    // `componentImports` marks it as a place primitives are imported from, but what it holds
    // are app composites — a dialog, a collapse, a date-range picker — and their overrides of a
    // shared primitive are exactly what `no-restyle` exists to report.
    files: ['packages/client/src/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'shadcn/no-restyle': 'off',
      'shadcn/no-arbitrary-values': 'off',
      'shadcn/require-static-classes': 'off',
    },
  },
  {
    files: ['**/.eslintrc.js', '**/jest.config.js', 'client/vite.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: [
      '**/*.test.js',
      '**/*.test.jsx',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.js',
      '**/*.spec.jsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/setupTests.js',
    ],
    settings: {
      jest: {
        globalAliases: {
          describe: ['describeIfFerretDB', 'describeLive'],
          it: ['itIfFerretDB'],
        },
      },
    },
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: {
      // TEST
      'jest/no-standalone-expect': ['error', { additionalTestBlockFunctions: ['itIfFerretDB'] }],
      'react/display-name': 'off',
      'react/prop-types': 'off',
      'jest/no-commented-out-tests': 'off',
      'react/no-unescaped-entities': 'off',
      'jest/no-conditional-expect': 'off',
      'jest/no-disabled-tests': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // A spec's fixture markup is an assertion, not a design surface.
      'shadcn/no-restyle': 'off',
      'shadcn/no-raw-colors': 'off',
      'shadcn/no-arbitrary-values': 'off',
      'shadcn/no-inline-styles': 'off',
      'shadcn/require-static-classes': 'off',
      'shadcn/no-unknown-classes': 'off',
    },
  },
  ...compat
    .extends(
      'plugin:@typescript-eslint/eslint-recommended',
      'plugin:@typescript-eslint/recommended',
    )
    .map((config) => ({
      ...config,
      files: ['**/*.ts', '**/*.tsx'],
    })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    // Package, E2E, and root integration tests are not part of the client
    // TypeScript project. They still get the recommended rules above.
    ignores: ['packages/**/*', 'client/vite.config.ts', 'e2e/**/*', 'src/tests/**/*'],
    plugins: {
      '@typescript-eslint': typescriptEslintEslintPlugin,
      jest: fixupPluginRules(jest),
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 5,
      sourceType: 'script',
    },
    rules: {
      // i18n
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          'should-validate-template': true,
        },
      ],
      //
      'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      // React
      'react/no-unknown-property': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // General
      'no-constant-binary-expression': 'off',
    },
  },
  {
    // **Data-provider specific configuration block**
    files: ['./packages/data-provider/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['./api/demo/**/*.ts'],
  },
  {
    files: ['./packages/api/**/*.ts'],
    rules: {
      'lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['./config/translations/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 5,
      sourceType: 'script',
    },
  },
  {
    files: ['./packages/data-provider/specs/**/*.ts'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
    },
  },
  {
    files: ['./api/demo/specs/**/*.ts'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
    },
  },
  {
    files: ['./packages/api/specs/**/*.ts'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
    },
  },
  {
    // **Data-schemas — shared rules for all TS files**
    files: ['./packages/data-schemas/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        project: [
          './packages/data-schemas/tsconfig.json',
          './packages/data-schemas/misc/ferretdb/tsconfig.json',
          './packages/data-schemas/misc/documentdb/tsconfig.json',
        ],
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['packages/data-schemas/**/*.ts', 'packages/api/**/*.{ts,js}', 'api/**/*.{ts,js}'],
    ignores: ['**/*.spec.{ts,js}', '**/*.test.{ts,js}'],
    rules: {
      'no-restricted-syntax': ['error', ...tenantModelRestrictions],
    },
  },
  {
    // **Data-schemas — ban model APIs that bypass tenant isolation in production code**
    // Raw driver calls bypass the plugin; bulkSave also bypasses query filter scoping.
    // Tests and the tenantSafeBulkWrite wrapper itself are excluded.
    files: ['./packages/data-schemas/**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.test.ts', '**/utils/tenantBulkWrite.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='bulkWrite']",
          message:
            'Use tenantSafeBulkWrite() instead of Model.bulkWrite() — Mongoose middleware does not fire for bulkWrite, so the tenant isolation plugin cannot intercept it.',
        },
        {
          selector: "MemberExpression[property.name='collection'][parent.type='MemberExpression']",
          message:
            'Avoid Model.collection.* — raw driver calls bypass all Mongoose middleware including tenant isolation. Use Mongoose model methods or tenantSafeBulkWrite() instead.',
        },
        ...tenantModelRestrictions,
      ],
    },
  },
];
