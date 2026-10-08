/**
 * Jest config for Amazon DocumentDB live-compatibility tests.
 * These tests require network access to a real Amazon DocumentDB cluster
 * (VPC-only — run from a bastion/tunnel) and are NOT run in CI by default.
 *
 * Usage:
 *   DOCUMENTDB_URI="mongodb://user:pass@127.0.0.1:27017/librechat_compat?tls=true&retryWrites=false" \
 *   DOCUMENTDB_TLS_CA_FILE="global-bundle.pem" \
 *     npx jest --config misc/documentdb/jest.documentdb.config.mjs
 */
export default {
  rootDir: '../..',
  testMatch: ['<rootDir>/misc/documentdb/**/*.documentdb.spec.ts'],
  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^~/(.*)$': '<rootDir>/src/$1',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!mdast-util-|micromark|decode-named-character-reference|devlop|longest-streak|unist-util-|zwitch|character-(?:entities|reference)|parse-entities|stringify-entities|is-(?:alphanumerical|alphabetical|decimal|hexadecimal)|ccount|markdown-table|escape-string-regexp)',
  ],
  restoreMocks: true,
  testTimeout: 120000,
};
