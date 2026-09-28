/** v0.8.8-rc4 */
const { maxWorkers } = require('../config/jest.workers.cjs');

module.exports = {
  roots: ['<rootDir>/src'],
  testEnvironment: 'jsdom',
  testEnvironmentOptions: {
    url: 'http://localhost:3080',
  },
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!<rootDir>/node_modules/',
    '!src/**/*.css.d.ts',
    '!src/**/*.d.ts',
  ],
  coveragePathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/test/setupTests.js'],
  //  Todo: Add coverageThreshold once we have enough coverage
  //  Note: eventually we want to have these values set to 80%
  // coverageThreshold: {
  //   global: {
  //     functions: 9,
  //     lines: 40,
  //     statements: 40,
  //     branches: 12,
  //   },
  // },
  moduleNameMapper: {
    '\\.(css)$': 'identity-obj-proxy',
    /** Mirror the vite resolve.alias so tests parse math with the same tokenizer as production. */
    '^micromark-extension-math$': 'micromark-extension-llm-math',
    '\\.(jpg|jpeg|png|gif|eot|otf|webp|svg|ttf|woff|woff2|mp4|webm|wav|mp3|m4a|aac|oga)$':
      'jest-file-loader',
    '^test/(.*)$': '<rootDir>/test/$1',
    '^~/(.*)$': '<rootDir>/src/$1',
    '^librechat-data-provider/react-query$':
      '<rootDir>/../node_modules/librechat-data-provider/src/react-query',
  },
  maxWorkers,
  /** Coverage maps accumulate for the life of a worker, so a long run can push
   * a worker past a gigabyte and get it killed by the OS, which fails whatever
   * suite it was holding. Recycling bloated workers also avoids swap thrash. */
  workerIdleMemoryLimit: '800MB',
  restoreMocks: true,
  testResultsProcessor: 'jest-junit',
  coverageReporters: ['text', 'cobertura', 'lcov'],
  resolver: '<rootDir>/jest.resolver.cjs',
  transform: {
    '\\.[jt]sx?$': 'babel-jest',
    '\\.(jpg|jpeg|png|gif|eot|otf|webp|svg|ttf|woff|woff2|mp4|webm|wav|mp3|m4a|aac|oga)$':
      'jest-file-loader',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@ariakit/react-components|@ariakit/react-utils|@ariakit/react-store|@ariakit/components|@ariakit/store|@ariakit/utils|@zattoo/use-double-click|@dicebear|@react-dnd|react-dnd.*|dnd-core|filenamify|filename-reserved-regex|heic-to|lowlight|highlight\\.js|fault|lucide-react|lucide|morphicons|react-markdown|unified|bail|trough|devlop|is-.*|parse-entities|stringify-entities|character-.*|trim-lines|style-to-object|inline-style-parser|html-url-attributes|escape-string-regexp|longest-streak|zwitch|ccount|markdown-table|comma-separated-tokens|space-separated-tokens|web-namespaces|property-information|remark-.*|rehype-.*|recma-.*|hast.*|mdast-.*|unist-.*|vfile.*|micromark.*|estree-util-.*|decode-named-character-reference)/)/',
  ],
  setupFiles: ['<rootDir>/test/polyfills.js'],
  setupFilesAfterEnv: ['@testing-library/jest-dom/extend-expect', '<rootDir>/test/setupTests.js'],
  clearMocks: true,
};
