const { maxWorkers } = require('../../config/jest.workers.cjs');

module.exports = {
  collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!<rootDir>/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageReporters: ['text', 'cobertura'],
  maxWorkers,
  restoreMocks: true,
  // sse.js and some of @librechat/client's dependencies ship ES modules only, so jest transforms
  // them like the package's own sources.
  transformIgnorePatterns: [
    '/node_modules/(?!(sse\\.js|@dicebear|lucide|lucide-react|morphicons|@ariakit/(react-components|react-utils|react-store|components|store|utils))/)',
  ],
  // The component library's resolver: its ESM-only @ariakit packages need the `import` condition.
  resolver: '<rootDir>/../client/jest.resolver.cjs',
  // The core runs without a DOM; a React spec opts into jsdom with a docblock.
  testEnvironment: 'node',
  setupFilesAfterEnv: ['@testing-library/jest-dom/extend-expect'],
};
