import { fileURLToPath } from 'node:url';
import path from 'node:path';
import typescriptEslintEslintPlugin from '@typescript-eslint/eslint-plugin';
import { fixupConfigRules, fixupPluginRules } from '@eslint/compat';
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
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
      'packages/data-schemas/misc/**/*',
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
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: {
      // TEST
      'react/display-name': 'off',
      'react/prop-types': 'off',
      'jest/no-commented-out-tests': 'off',
      'react/no-unescaped-entities': 'off',
      'jest/no-conditional-expect': 'off',
      'jest/no-disabled-tests': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
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
    // e2e specs keep only the non-type-checked recommended rules from the block above.
    ignores: ['packages/**/*', 'client/vite.config.ts', 'e2e/**/*'],
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
