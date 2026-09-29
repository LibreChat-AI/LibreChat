/**
 * Boots the worker half of the `api/server/experimental.js` entrypoint once with
 * `DISABLE_STARTUP_TASKS` set. The file branches on `cluster.isMaster`, so the branch is flipped
 * before the require rather than forking a real cluster.
 *
 * Requirements: 5.4, 5.5, 5.14, 5.15, 5.16, 6.9
 */
const cluster = require('cluster');
const mongoose = require('mongoose');
const { startupTasksDisabledWarning } = require('@librechat/api');
const {
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
} = require('~/test/helpers/startup');

/* Set before the entrypoint is required: `~/db/connect` and the gate both read at load. */
const restoreEnv = overrideEnv({
  DISABLE_STARTUP_TASKS: 'true',
  MONGO_AUTO_CREATE: 'false',
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

describe('Startup task gate on the experimental.js entrypoint, flag set', () => {
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

    await waitFor(() => logLines.warn.includes(startupTasksDisabledWarning), {
      message: 'the suppressed-startup-work warning that closes the post-listen section',
      logLines,
    });

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

  it('runs no bootstrap writer', () => {
    expect(calls.seedDatabase).toBe(0);
    expect(calls.updateInterfacePermissions).toBe(0);
    expect(calls.initializeGitHubSkillSync).toBe(0);
    expect(calls.sweepOrphanedPreviews).toBe(0);
    expect(calls.startExpiredFileSweep).toBe(0);
  });

  it('does not run checkMigrations', () => {
    expect(calls.checkMigrations).toBe(0);
  });

  it('does not initialize MCPs: no registry creation, no MCP server dialing, no leader election', () => {
    expect(calls.createMCPServersRegistry).toBe(0);
    expect(calls.createMCPManager).toBe(0);
    expect(fetchRequests).toEqual([]);
  });

  it('does not initialize the OAuth reconnect manager', () => {
    expect(calls.createOAuthReconnectionManager).toBe(0);
  });

  it('runs none of the newly gated calls this entrypoint makes', () => {
    /* This entrypoint gates subagent task routing, the code-environment lifecycle reconciler, and
     * the agent-trigger service; it arms no schedule engine and loads no deployment plugins, so
     * those stay at zero in both flag states. */
    expect(calls.configureSubagentTaskRouting).toBe(0);
    expect(calls.startCodeEnvironmentLifecycleReconciler).toBe(0);
    expect(calls.initializeAgentTriggerService).toBe(0);
  });

  it('still runs performStartupChecks and issues no RAG health request', () => {
    expect(calls.performStartupChecks).toBe(1);
    expect(fetchRequests.filter((url) => url.includes('/health'))).toEqual([]);
  });

  it('completes the post-listen section without entering its failure handler', () => {
    expect(logLines.error).not.toEqual(
      expect.arrayContaining([expect.stringContaining('post-listen initialization failed')]),
    );
  });

  it.each(BOOTSTRAP_COLLECTIONS)('attempts no write against `%s`', (collectionName) => {
    expect(database.writesTo(collectionName)).toEqual([]);
  });

  it('emits the suppressed-startup-work warning exactly once', () => {
    const warnings = logLines.warn.filter((line) => line === startupTasksDisabledWarning);

    expect(warnings).toHaveLength(1);
  });
});
