export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  transform: {
    '\\.[jt]s$': [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!mdast-util-|micromark|decode-named-character-reference|devlop|longest-streak|unist-util-|zwitch|character-(?:entities|reference)|parse-entities|stringify-entities|is-(?:alphanumerical|alphabetical|decimal|hexadecimal)|ccount|markdown-table|escape-string-regexp)',
  ],
  testTimeout: 15000,
  restoreMocks: true,
};
