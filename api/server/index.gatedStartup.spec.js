/**
 * Boots the `api/server/index.js` entrypoint once with `DISABLE_STARTUP_TASKS` set and asserts
 * what the gate suppresses and what it leaves on the normal path. The environment values mirror
 * the auth surface's row of the per-container matrix.
 *
 * Requirements: 5.4, 5.5, 5.9, 5.14, 5.15, 5.16, 5.20, 5.22, 5.24, 6.9
 */
const request = require('supertest');
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

describe('Startup task gate on the index.js entrypoint, flag set', () => {
  jest.setTimeout(60_000);

  let mongoServer;
  let app;
  let calls;
  let database;
  let logLines;
  let fetchRequests;
  let httpServers;

  beforeAll(async () => {
    stubClientAssets();
    mongoServer = await startInMemoryMongo();

    calls = observeStartupCalls();
    database = observeDatabaseOperations();
    logLines = captureLogLines();
    fetchRequests = stubOutboundFetch();
    httpServers = observeHttpServers();

    app = require('~/server');

    await waitFor(async () => (await request(app).get('/readyz')).status === 200, {
      message: '/readyz to report ready',
      logLines,
    });

    logLines.endBootWindow();
  });

  afterAll(async () => {
    database.stop();
    await httpServers.stop();
    await mongoose.disconnect();
    await mongoServer.stop();
    restoreEnv();
  });

  it('runs no bootstrap writer', () => {
    expect(calls.seedDatabase).toBe(0);
    expect(calls.updateInterfacePermissions).toBe(0);
    expect(calls.initializeDeploymentSkills).toBe(0);
    expect(calls.initializeGitHubSkillSync).toBe(0);
    expect(calls.sweepOrphanedPreviews).toBe(0);
    expect(calls.startExpiredFileSweep).toBe(0);
  });

  it('does not run checkMigrations', () => {
    expect(calls.checkMigrations).toBe(0);
  });

  it('does not initialize MCPs: no registry creation, no MCP server dialing, no leader election', () => {
    /* Boot-time leader election is entered only from the registry initializer, and
     * `createMCPServersRegistry` is that initializer's sole entry point, so zero registry
     * creations is the observable for non-participation. Dialing is covered by the same count
     * together with the absence of any outbound request. */
    expect(calls.createMCPServersRegistry).toBe(0);
    expect(calls.createMCPManager).toBe(0);
    expect(fetchRequests).toEqual([]);
  });

  it('does not initialize the OAuth reconnect manager', () => {
    expect(calls.createOAuthReconnectionManager).toBe(0);
  });

  it('runs none of the newly gated pre-listen calls', () => {
    /* Deployment-plugin initialization and the plugin-hook registration it installs
     * (`setPluginHookSource`), subagent task routing, and the code-environment lifecycle
     * reconciler. */
    expect(calls.initializeDeploymentPlugins).toBe(0);
    expect(calls.setPluginHookSource).toBe(0);
    expect(calls.configureSubagentTaskRouting).toBe(0);
    expect(calls.startCodeEnvironmentLifecycleReconciler).toBe(0);
  });

  it('does not initialize the agent-trigger service', () => {
    expect(calls.initializeAgentTriggerService).toBe(0);
  });

  it('does not arm the schedule engine or run its expired-approval callback', () => {
    /* The expired-approval callback settles expired approvals only from an armed engine; a zero
     * arming count is the observable that it never fires. */
    expect(calls.initializeScheduleEngine).toBe(0);
  });

  it('emits no error-level line reporting a permanently unavailable schedule engine', () => {
    /* Suppression is silent: on the auth surface an unarmed engine is the intended state, not a
     * fault, so the terminal "PERMANENTLY unavailable" error the unarmed path emits must not
     * appear. */
    expect(logLines.error).not.toEqual(
      expect.arrayContaining([expect.stringContaining('PERMANENTLY unavailable')]),
    );
  });

  it('answers /readyz with 200 after the post-listen section completes', async () => {
    const response = await request(app).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');
  });

  it('completes the post-listen section without entering its failure handler', () => {
    expect(logLines.error).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Post-listen initialization failed')]),
    );
  });

  it('answers the SPA index.html fallback with 200', async () => {
    const response = await request(app).get('/some/spa/route');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/html/);
  });

  it('still runs performStartupChecks', () => {
    expect(calls.performStartupChecks).toBe(1);
  });

  it('issues no RAG health request', () => {
    expect(fetchRequests.filter((url) => url.includes('/health'))).toEqual([]);
  });

  it('issues no read of `users` for the credential-database check', () => {
    expect(database.operations.filter((op) => op.collectionName === 'users')).toEqual([]);
  });

  it('never accesses `librechatCredentialMetadata`', () => {
    expect(
      database.operations.filter((op) => op.collectionName === 'librechatCredentialMetadata'),
    ).toEqual([]);
  });

  it('attempts no credential fingerprint upsert', () => {
    expect(database.writesTo('librechatCredentialMetadata')).toEqual([]);
  });

  it.each(BOOTSTRAP_COLLECTIONS)('attempts no write against `%s`', (collectionName) => {
    expect(database.writesTo(collectionName)).toEqual([]);
  });

  it.each(BOOTSTRAP_COLLECTIONS)('leaves `%s` unmaterialized', async (collectionName) => {
    const collections = await mongoose.connection.db.listCollections().toArray();

    expect(collections.map(({ name }) => name)).not.toContain(collectionName);
  });

  it('emits the suppressed-startup-work warning exactly once', () => {
    const warnings = logLines.warn.filter((line) => line === startupTasksDisabledWarning);

    expect(warnings).toHaveLength(1);
  });
});
