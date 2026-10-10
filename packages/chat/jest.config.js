const { maxWorkers } = require('../../config/jest.workers.cjs');

module.exports = {
  collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!<rootDir>/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageReporters: ['text', 'cobertura'],
  maxWorkers,
  restoreMocks: true,
  // The core runs without a DOM; a React spec opts into jsdom with a docblock.
  testEnvironment: 'node',
};
