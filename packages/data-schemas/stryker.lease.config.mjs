import config from './stryker.config.mjs';

export default {
  ...config,
  jest: {
    ...config.jest,
    configFile: 'packages/data-schemas/jest.lease.config.mjs',
    config: { testMatch: ['<rootDir>/src/methods/resourceLock.spec.ts'] },
  },
  mutate: ['packages/data-schemas/src/methods/resourceLock.ts'],
  incrementalFile: 'packages/data-schemas/coverage/leases/incremental.json',
  jsonReporter: { fileName: 'packages/data-schemas/coverage/leases/mutation.json' },
  htmlReporter: { fileName: 'packages/data-schemas/coverage/leases/mutation.html' },
};
