const { maxWorkers, workerIdleMemoryLimit } = require('../config/jest.workers.cjs');

const esModules = [
  '@librechat/agents',
  'openid-client',
  'oauth4webapi',
  'jose',
  '@langchain/langgraph',
  '@langchain/langgraph-checkpoint',
  '@langchain/langgraph-sdk',
  '@mistralai/mistralai',
  '@modelcontextprotocol/ext-apps',
  'uuid',
  'sanitize-html',
  'htmlparser2',
  'domhandler',
  'domelementtype',
  'domutils',
  'dom-serializer',
  'entities',
].join('|');

module.exports = {
  testEnvironment: require.resolve('../config/jest.environment.cjs'),
  clearMocks: true,
  roots: ['<rootDir>'],
  coverageDirectory: 'coverage',
  maxWorkers,
  workerIdleMemoryLimit,
  testTimeout: 30000, // 30 seconds timeout for all tests
  setupFiles: [
    './test/jestSetup.js',
    './test/__mocks__/logger.js',
    require.resolve('../config/jest.setup.mongo.cjs'),
  ],
  moduleNameMapper: {
    '~/(.*)': '<rootDir>/$1',
    '~/data/auth.json': '<rootDir>/__mocks__/auth.mock.json',
    '^openid-client/passport$': '<rootDir>/test/__mocks__/openid-client-passport.js',
    '^openid-client$': '<rootDir>/test/__mocks__/openid-client.js',
  },
  transform: {
    '\\.[cm]?[jt]sx?$': [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' } }],
          '@babel/preset-typescript',
        ],
      },
    ],
  },
  transformIgnorePatterns: [`/node_modules/(?!(${esModules})/).*/`],
};
