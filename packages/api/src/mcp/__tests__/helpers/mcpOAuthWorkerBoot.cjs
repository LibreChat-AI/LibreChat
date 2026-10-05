'use strict';

/**
 * Bootstrap for the MCP OAuth multi-process harness.
 *
 * The worker must be a REAL separate process, not a second in-process instance: process-local
 * single-flight maps, connection caches and module state would otherwise satisfy a cross-replica
 * assertion that production cannot satisfy. Jest's transform is unavailable outside the test
 * process, so compile the TypeScript worker with ts-node and resolve the package's `~/*` alias
 * the same way tsconfig.json declares it.
 *
 * Nothing here fakes a production adapter. Mongo, Redis, encryption and the OAuth handler are the
 * real implementations; only the provider and the stores are test-owned.
 */

const path = require('path');

const apiRoot = path.resolve(__dirname, '../../../..');

require('ts-node').register({
  transpileOnly: true,
  esm: false,
  project: path.join(apiRoot, 'tsconfig.json'),
  compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
});

require('tsconfig-paths').register({
  baseUrl: apiRoot,
  paths: { '~/*': ['./src/*'] },
});

require('./mcpOAuthWorkerMain.ts');
