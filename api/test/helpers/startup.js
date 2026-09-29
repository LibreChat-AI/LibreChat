/**
 * Shared harness for the entrypoint-level `DISABLE_STARTUP_TASKS` specs
 * (`index.gatedStartup`, `index.ungatedStartup`, `experimental.gatedStartup`,
 * `experimental.ungatedStartup`).
 *
 * Every observation here wraps the real function and calls through to it, so the gated and
 * ungated boots exercise the same code the deployment runs. The recorders keep their own
 * durable arrays because the workspace Jest config sets `clearMocks`, which wipes
 * `mock.calls` before each test — a boot that happens in `beforeAll` would otherwise leave
 * nothing to assert on.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/** Collections R6.9 requires a gated container to leave untouched during startup. */
const BOOTSTRAP_COLLECTIONS = Object.freeze([
  'roles',
  'accessroles',
  'agentcategories',
  'systemgrants',
  'skills',
  'aclentries',
  'files',
]);

/** Driver-level operations that mutate data, indexes, or collection existence. */
const WRITE_METHODS = new Set([
  'bulkWrite',
  'createCollection',
  'createIndex',
  'createIndexes',
  'deleteMany',
  'deleteOne',
  'drop',
  'dropIndex',
  'dropIndexes',
  'findAndModify',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'insert',
  'insertMany',
  'insertOne',
  'remove',
  'rename',
  'replaceOne',
  'update',
  'updateMany',
  'updateOne',
]);

const INDEX_HTML =
  '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>';

/**
 * Applies the environment an entrypoint boot needs and returns the restore function. Boot
 * environment has to be set before the entrypoint is required, and undone afterwards so it does
 * not leak into the next spec file sharing the Jest worker.
 */
function overrideEnv(values) {
  const originals = {};

  for (const [key, value] of Object.entries(values)) {
    originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }
      process.env[key] = value;
    }
  };
}

/** Writes the `dist`, `fonts`, and `assets` trees both entrypoints read at boot. */
function stubClientAssets() {
  for (const dir of ['/tmp/dist', '/tmp/fonts', '/tmp/assets']) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  fs.writeFileSync(path.join('/tmp/dist', 'index.html'), INDEX_HTML);
}

/**
 * Starts an in-memory MongoDB and points `MONGO_URI` at it. Must run before the entrypoint is
 * required: `~/db/connect` reads `MONGO_URI` at module load.
 */
async function startInMemoryMongo() {
  const mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();
  return mongoServer;
}

/**
 * Records every HTTP server a boot puts into `listen` so teardown can close it. Must be called
 * before the entrypoint is required: both entrypoints call `app.listen` during boot and neither
 * exports the resulting server, and a still-listening socket keeps the Jest worker's event loop
 * alive after the last assertion — the worker then has to be force-exited, which the workspace's
 * `test:ci` script does not do.
 *
 * Servers `supertest` opens per request are recorded too; they have already closed themselves by
 * teardown, which is what the `listening` check skips.
 */
function observeHttpServers() {
  const servers = [];
  const originalListen = http.Server.prototype.listen;

  http.Server.prototype.listen = function trackedListen(...args) {
    servers.push(this);
    return originalListen.apply(this, args);
  };

  return {
    stop: async () => {
      http.Server.prototype.listen = originalListen;

      for (const server of servers) {
        /* Keep-alive sockets outlive `close()`, which waits for existing connections. */
        server.closeAllConnections();
        if (!server.listening) {
          continue;
        }
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };
}

/**
 * Records every driver operation Mongoose issues on the default connection, through the
 * connection's own `operation-start` event rather than by replacing any database code.
 */
function observeDatabaseOperations() {
  const operations = [];
  const listener = ({ collectionName, method }) => operations.push({ collectionName, method });
  mongoose.connection.on('operation-start', listener);

  return {
    operations,
    writes: () => operations.filter(({ method }) => WRITE_METHODS.has(method)),
    writesTo: (collectionName) =>
      operations.filter(
        (operation) =>
          operation.collectionName === collectionName && WRITE_METHODS.has(operation.method),
      ),
    stop: () => mongoose.connection.off('operation-start', listener),
  };
}

/**
 * Collects the `warn` and `error` lines emitted during boot. Errors are echoed to stderr until
 * `endBootWindow()` is called: a boot failure exits the process before any assertion runs, so
 * without the echo the run reports nothing but a dead worker.
 */
function captureLogLines() {
  const { logger } = require('@librechat/data-schemas');
  let echoErrors = true;
  const lines = {
    warn: [],
    error: [],
    endBootWindow: () => {
      echoErrors = false;
    },
  };

  for (const level of ['warn', 'error']) {
    jest.spyOn(logger, level).mockImplementation((...args) => {
      const line = args
        .map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg)))
        .join(' ');
      lines[level].push(line);
      if (level === 'error' && echoErrors) {
        process.stderr.write(`[boot error] ${line}\n`);
      }
    });
  }

  return lines;
}

/**
 * Intercepts outbound `fetch` so the RAG health probe never leaves the test process. Interception
 * is confined to that external HTTP endpoint; everything else in these specs runs for real.
 */
function stubOutboundFetch() {
  const requests = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    requests.push(String(url));
    return new Response('', { status: 200 });
  });
  return requests;
}

/**
 * Wraps each gated startup call with a call-through spy and returns a durable call-count record.
 *
 * MCP initialization and OAuth reconnect initialization are observed at their initializer
 * boundary (`~/config`): both entrypoints reach them through function-valued module exports that
 * cannot be spied on in place, and `~/config` is already substituted for every spec in this
 * workspace by `test/__mocks__/logger.js`.
 */
function observeStartupCalls() {
  const models = require('~/models');
  const api = require('@librechat/api');
  const mcp = require('~/config');
  const skillSync = require('~/server/services/Skills/sync');
  const fileProcess = require('~/server/services/Files/process');
  const migration = require('~/server/services/start/migration');
  const subagentThreadStore = require('~/server/services/Endpoints/agents/subagentThreadStore');
  const agentTriggers = require('~/server/services/Agents/triggers');
  const schedules = require('~/server/services/Schedules');

  const counts = {};
  const track = (name, target, method) => {
    counts[name] = 0;
    const original = target[method];

    if (jest.isMockFunction(original)) {
      /* `jest.spyOn` hands back an existing mock rather than wrapping it, so setting an
       * implementation on it would make the call-through re-enter the same function. */
      target[method] = (...args) => {
        counts[name] += 1;
        return original(...args);
      };
      return;
    }

    jest.spyOn(target, method).mockImplementation((...args) => {
      counts[name] += 1;
      return original.apply(target, args);
    });
  };

  track('seedDatabase', models, 'seedDatabase');
  track('sweepOrphanedPreviews', models, 'sweepOrphanedPreviews');
  track('updateInterfacePermissions', api, 'updateInterfacePermissions');
  track('initializeDeploymentSkills', api, 'initializeDeploymentSkills');
  track('performStartupChecks', api, 'performStartupChecks');
  track('initializeGitHubSkillSync', skillSync, 'initializeGitHubSkillSync');
  track('startExpiredFileSweep', fileProcess, 'startExpiredFileSweep');
  track('checkMigrations', migration, 'checkMigrations');
  track('createMCPServersRegistry', mcp, 'createMCPServersRegistry');
  track('createMCPManager', mcp, 'createMCPManager');
  track('createOAuthReconnectionManager', mcp, 'createOAuthReconnectionManager');

  /* The widened gated set (tasks 1.2-1.4). Each is spied at the module boundary the entrypoint
   * reaches it through, so the count reflects the real gated call rather than a replaced module.
   *
   * `initializeDeploymentPlugins` and `startCodeEnvironmentLifecycleReconciler` are
   * `@librechat/api` exports and are tracked there. `setPluginHookSource` is the plugin-hook
   * registration the entrypoint installs inside the same gated block (it receives
   * `registerDeploymentPluginHooks`), so its count is the observable for hook registration.
   * `initializeScheduleEngine`'s count doubles as the observable for its expired-approval
   * callback, which cannot fire when the engine never arms. `setPluginHookSource` and the
   * schedule engine are wired only in `index.js`; `experimental.js` never invokes them, so its
   * specs read those counts as 0 in both flag states. */
  track('initializeDeploymentPlugins', api, 'initializeDeploymentPlugins');
  track('setPluginHookSource', api, 'setPluginHookSource');
  track('startCodeEnvironmentLifecycleReconciler', api, 'startCodeEnvironmentLifecycleReconciler');
  track('configureSubagentTaskRouting', subagentThreadStore, 'configureSubagentTaskRouting');
  track('initializeAgentTriggerService', agentTriggers, 'initializeAgentTriggerService');
  track('initializeScheduleEngine', schedules, 'initializeScheduleEngine');

  return counts;
}

/**
 * Waits until the default connection has issued no driver operation for `quietMs`, so a boot with
 * no single end-of-boot signal (the ungated `experimental.js` worker) is not torn down while its
 * post-listen awaits are still in flight. Tearing down early closes the Mongo client under those
 * in-flight operations, which surfaces as `Client must be connected` / `client was closed` errors
 * and a post-listen `process.exit(1)` — a teardown race, not a boot failure. Pair it with a
 * primary `waitFor` on the last post-listen call so this only measures the tail.
 */
async function waitForQuietDatabase(
  database,
  { quietMs = 750, timeoutMs = 25_000, intervalMs = 50 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = database.operations.length;
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (database.operations.length !== lastCount) {
      lastCount = database.operations.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
}

/** Polls `predicate` until it resolves truthy, reporting collected `error` lines on timeout. */
async function waitFor(predicate, { message, logLines, timeoutMs = 25_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const errors = logLines?.error?.length ? `\nLogged errors:\n${logLines.error.join('\n')}` : '';
  throw new Error(`Timed out waiting for ${message} after ${timeoutMs}ms.${errors}`);
}

module.exports = {
  BOOTSTRAP_COLLECTIONS,
  captureLogLines,
  observeDatabaseOperations,
  observeHttpServers,
  observeStartupCalls,
  overrideEnv,
  startInMemoryMongo,
  stubClientAssets,
  stubOutboundFetch,
  waitFor,
  waitForQuietDatabase,
};
