import { maxWorkers } from '../../config/jest.workers.cjs';

export default {
  collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!<rootDir>/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/misc/'],
  transformIgnorePatterns: [
    '/node_modules/(?!mdast-util-|micromark|decode-named-character-reference|devlop|longest-streak|unist-util-|zwitch|character-(?:entities|reference)|parse-entities|stringify-entities|is-(?:alphanumerical|alphabetical|decimal|hexadecimal)|ccount|markdown-table|escape-string-regexp)',
  ],
  coverageReporters: ['text', 'cobertura'],
  testResultsProcessor: 'jest-junit',
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^~/(.*)$': '<rootDir>/src/$1',
  },
  // coverageThreshold: {
  //   global: {
  //     statements: 58,
  //     branches: 49,
  //     functions: 50,
  //     lines: 57,
  //   },
  // },
  // Download the in-memory MongoDB binary once, before workers fork: on a cold
  // cache the parallel downloads race their final rename and fail whole suites.
  globalSetup: '<rootDir>/jest.globalSetup.mjs',
  setupFiles: ['<rootDir>/../../config/jest.setup.logging.cjs'],
  maxWorkers,
  restoreMocks: true,
  testTimeout: 15000,
};
