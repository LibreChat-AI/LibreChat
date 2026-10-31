import config from './jest.favorite.config.mjs';

export default {
  ...config,
  testMatch: ['<rootDir>/src/methods/resourceLock*.spec.ts'],
  collectCoverageFrom: ['src/methods/resourceLock.ts'],
  coverageDirectory: '<rootDir>/coverage/leases',
};
