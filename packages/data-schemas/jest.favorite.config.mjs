import { createRequire } from 'node:module';
import config from './jest.config.mjs';

const require = createRequire(import.meta.url);

export default {
  ...config,
  // Stryker must use Jest's own environment even when npm nests its dependencies.
  testEnvironment: require.resolve('jest-environment-node', { paths: [require.resolve('jest')] }),
  testMatch: ['<rootDir>/src/methods/favorite*.spec.ts'],
  collectCoverageFrom: ['src/methods/favorite.ts'],
  coverageDirectory: '<rootDir>/coverage/favorites',
  coverageReporters: ['text', 'json'],
  testResultsProcessor: undefined,
  maxWorkers: 1,
};
