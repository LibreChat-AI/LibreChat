const { maxWorkers } = require('../../config/jest.workers.cjs');

module.exports = {
  collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!<rootDir>/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageReporters: ['text', 'cobertura'],
  maxWorkers,
  restoreMocks: true,
  // sse.js, some of @librechat/client's dependencies and the micromark/mdast markdown parser
  // ship ES modules only, so jest transforms them like the package's own sources.
  transformIgnorePatterns: [
    '/node_modules/(?!(sse\\.js|@dicebear|lucide|lucide-react|morphicons|@ariakit/(react-components|react-utils|react-store|components|store|utils)|micromark.*|mdast-.*|unist-.*|decode-named-character-reference|character-.*|devlop|ccount|longest-streak|markdown-table|zwitch|escape-string-regexp|parse-entities|stringify-entities|is-.*)/)',
  ],
  // The component library's resolver: its ESM-only @ariakit packages need the `import` condition.
  resolver: '<rootDir>/../client/jest.resolver.cjs',
  // `test/` imports the package by its published entry names, as a consumer would; this points
  // those names at the sources so the suite needs no package build.
  moduleNameMapper: {
    '^@librechat/chat$': '<rootDir>/src/index.ts',
    '^@librechat/chat/(react|components)$': '<rootDir>/src/$1.ts',
  },
  // The core runs without a DOM; a React spec opts into jsdom with a docblock.
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.polyfills.js'],
  setupFilesAfterEnv: ['@testing-library/jest-dom/extend-expect'],
};
