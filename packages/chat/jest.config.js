const { maxWorkers } = require('../../config/jest.workers.cjs');

module.exports = {
  collectCoverageFrom: ['src/**/*.{js,jsx,ts,tsx}', '!<rootDir>/node_modules/'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageReporters: ['text', 'cobertura'],
  maxWorkers,
  restoreMocks: true,
  // sse.js, react-dnd, some of @librechat/client's dependencies, the markdown pipeline (unified,
  // remark, rehype, micromark, mdast, hast) and the code highlighter ship ES modules only, so jest
  // transforms them like the package's own sources.
  transformIgnorePatterns: [
    '/node_modules/(?!(sse\\.js|lowlight|highlight\\.js|fault|@react-dnd|react-dnd.*|dnd-core|@dicebear|lucide|lucide-react|morphicons|@ariakit/(react-components|react-utils|react-store|components|store|utils)|react-markdown|unified|bail|trough|remark-.*|rehype-.*|hast.*|vfile.*|micromark.*|mdast-.*|unist-.*|estree-util-.*|decode-named-character-reference|character-.*|devlop|ccount|longest-streak|markdown-table|zwitch|escape-string-regexp|parse-entities|stringify-entities|trim-lines|style-to-object|inline-style-parser|html-url-attributes|comma-separated-tokens|space-separated-tokens|web-namespaces|property-information|is-.*)/)',
  ],
  // The component library's resolver: its ESM-only @ariakit packages need the `import` condition.
  resolver: '<rootDir>/../client/jest.resolver.cjs',
  // `test/` imports the package by its published entry names, as a consumer would; this points
  // those names at the sources so the suite needs no package build.
  moduleNameMapper: {
    '^@librechat/chat$': '<rootDir>/src/index.ts',
    '^@librechat/chat/(react|components)$': '<rootDir>/src/$1.ts',
    '^@librechat/chat/style\\.css$': '<rootDir>/src/style.css',
    // KaTeX's stylesheet, which the math loader imports for its effect. Only that one: the style
    // specs read the packages' real stylesheets.
    '^katex/dist/katex\\.min\\.css$': 'identity-obj-proxy',
  },
  // The core runs without a DOM; a React spec opts into jsdom with a docblock.
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.polyfills.js'],
  setupFilesAfterEnv: ['@testing-library/jest-dom/extend-expect'],
};
