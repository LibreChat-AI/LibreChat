/**
 * Boots the worker half of the `api/server/experimental.js` entrypoint once with
 * `DISABLE_STARTUP_TASKS` unset, asserting every gated call runs and the gate stays silent.
 *
 * The expired-file sweep is left out: in this entrypoint it starts only once the master assigns
 * the sweep worker over IPC, which no boot of a single worker reaches.
 *
 * Requirements: 5.19, 5.20
 */
const cluster = require('cluster');
const mongoose = require('mongoose');
const { startupTasksDisabledWarning } = require('@librechat/api');
const {
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
} = require('~/test/helpers/startup');

/* Index builds are not part of the gate, and leaving them on races the in-memory server's
 * shutdown during teardown. */
const restoreEnv = overrideEnv({
  DISABLE_STARTUP_TASKS: undefined,
  MONGO_AUTO_INDEX: 'false',
  PORT: '0',
  RAG_API_URL: 'http://rag.internal:8000',
});

jest.mock('~/server/services/Config', () => ({
  loadCustomConfig: jest.fn(() => Promise.resolve({})),
  getAppConfig: jest.fn().mockResolvedValue({
    paths: {
      uploads: '/tmp',
      dist: '/tmp/dist',
      fonts: '/tmp/fonts',
      assets: '/tmp/assets',
    },
    fileStrategy: 'local',
    imageOutputType: 'PNG',
  }),
  mergeAppTools: jest.fn(),
  /* The MCP initializer destructures `syncStaticTools` alongside `mergeAppTools`; the ungated
   * boot reaches its no-servers branch, which calls it. Without this export the initializer
   * throws `syncStaticTools is not a function`, failing the suite before any assertion. */
  syncStaticTools: jest.fn(),
  setCachedTools: jest.fn(),
}));

jest.mock('~/app/clients/tools', () => ({
  createOpenAIImageTools: jest.fn(() => []),
  createYouTubeTools: jest.fn(() => []),
  manifestToolMap: {},
  toolkits: [],
}));

jest.mock('~/config', () => ({
  createMCPServersRegistry: jest.fn(),
  getMCPServersRegistry: jest.fn(),
  createMCPManager: jest.fn().mockResolvedValue({
    getAppToolFunctions: jest.fn().mockResolvedValue({}),
  }),
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(),
  getActionFlowStateManager: jest.fn(),
  createOAuthReconnectionManager: jest.fn(),
  getOAuthReconnectionManager: jest.fn(),
}));

describe('Startup task gate on the experimental.js entrypoint, flag unset', () => {
  jest.setTimeout(60_000);

  const originalIsMaster = cluster.isMaster;

  let mongoServer;
  let calls;
  let database;
  let logLines;
  let fetchRequests;
  let httpServers;

  beforeAll(async () => {
    stubClientAssets();
    mongoServer = await startInMemoryMongo();

    cluster.isMaster = false;
    if (cluster.isMaster) {
      throw new Error(
        'cluster.isMaster could not be flipped: requiring the entrypoint would fork real workers.',
      );
    }

    calls = observeStartupCalls();
    database = observeDatabaseOperations();
    logLines = captureLogLines();
    fetchRequests = stubOutboundFetch();
    httpServers = observeHttpServers();

    require('~/server/experimental');

    /* `initializeAgentTriggerService` is the last post-listen call in this entrypoint, and it and
     * `checkMigrations` before it keep issuing DB operations after their spies increment. Waiting
     * on the call alone tears the worker down mid-flight; the quiet-database wait holds until the
     * post-listen tail settles so teardown does not close the client under an in-flight query. */
    await waitFor(() => calls.initializeAgentTriggerService > 0, {
      message: 'initializeAgentTriggerService, the last call of the post-listen section',
      logLines,
    });
    await waitForQuietDatabase(database);

    logLines.endBootWindow();
  });

  afterAll(async () => {
    database.stop();
    cluster.isMaster = originalIsMaster;
    await httpServers.stop();
    await mongoose.disconnect();
    await mongoServer.stop();
    restoreEnv();
  });

  it('runs every pre-listen bootstrap writer', () => {
    expect(calls.seedDatabase).toBe(1);
    expect(calls.updateInterfacePermissions).toBe(1);
    expect(calls.initializeGitHubSkillSync).toBe(1);
    expect(calls.sweepOrphanedPreviews).toBe(1);
  });

  it('runs checkMigrations', () => {
    expect(calls.checkMigrations).toBe(1);
  });

  it('initializes MCPs', () => {
    expect(calls.createMCPServersRegistry).toBe(1);
    expect(calls.createMCPManager).toBe(1);
  });

  it('initializes the OAuth reconnect manager', () => {
    expect(calls.createOAuthReconnectionManager).toBe(1);
  });

  it('runs the newly gated calls this entrypoint makes', () => {
    /* Subagent task routing, the code-environment lifecycle reconciler, and the agent-trigger
     * service. This entrypoint arms no schedule engine and loads no deployment plugins. */
    expect(calls.configureSubagentTaskRouting).toBe(1);
    expect(calls.startCodeEnvironmentLifecycleReconciler).toBe(1);
    expect(calls.initializeAgentTriggerService).toBe(1);
  });

  it('runs performStartupChecks and issues the RAG health request', () => {
    expect(calls.performStartupChecks).toBe(1);
    expect(fetchRequests).toContain('http://rag.internal:8000/health');
  });

  it('emits no suppressed-startup-work warning', () => {
    expect(logLines.warn).not.toContain(startupTasksDisabledWarning);
  });
});
