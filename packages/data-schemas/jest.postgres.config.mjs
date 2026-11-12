import config from './jest.config.mjs';

export default {
  ...config,
  testMatch: ['<rootDir>/src/postgres/*.spec.ts'],
  globalSetup: undefined,
  testResultsProcessor: undefined,
  maxWorkers: 1,
};
