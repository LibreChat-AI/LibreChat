/**
 * Boots the `api/server/index.js` entrypoint once with `DISABLE_STARTUP_TASKS` unset and asserts
 * that every gated startup call runs and that the gate emits no warning.
 *
 * Requirements: 5.19, 5.20
 */
const request = require('supertest');
const mongoose = require('mongoose');
const { startupTasksDisabledWarning } = require('@librechat/api');
const {
  captureLogLines,
  observeHttpServers,
  observeStartupCalls,
  overrideEnv,
  startInMemoryMongo,
  stubClientAssets,
  stubOutboundFetch,
  waitFor,
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

describe('Startup task gate on the index.js entrypoint, flag unset', () => {
  jest.setTimeout(60_000);

  let mongoServer;
  let app;
  let calls;
  let logLines;
  let fetchRequests;
  let httpServers;

  beforeAll(async () => {
    stubClientAssets();
    mongoServer = await startInMemoryMongo();

    calls = observeStartupCalls();
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
    await httpServers.stop();
    await mongoose.disconnect();
    await mongoServer.stop();
    restoreEnv();
  });

  it('runs every pre-listen bootstrap writer', () => {
    expect(calls.seedDatabase).toBe(1);
    expect(calls.updateInterfacePermissions).toBe(1);
    expect(calls.initializeDeploymentSkills).toBe(1);
    expect(calls.initializeGitHubSkillSync).toBe(1);
    expect(calls.sweepOrphanedPreviews).toBe(1);
    expect(calls.startExpiredFileSweep).toBe(1);
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

  it('runs every newly gated pre-listen call', () => {
    expect(calls.initializeDeploymentPlugins).toBe(1);
    expect(calls.setPluginHookSource).toBe(1);
    expect(calls.configureSubagentTaskRouting).toBe(1);
    expect(calls.startCodeEnvironmentLifecycleReconciler).toBe(1);
  });

  it('initializes the agent-trigger service', () => {
    expect(calls.initializeAgentTriggerService).toBe(1);
  });

  it('arms the schedule engine', () => {
    expect(calls.initializeScheduleEngine).toBe(1);
  });

  it('runs performStartupChecks and issues the RAG health request', () => {
    expect(calls.performStartupChecks).toBe(1);
    expect(fetchRequests).toContain('http://rag.internal:8000/health');
  });

  it('emits no suppressed-startup-work warning', () => {
    expect(logLines.warn).not.toContain(startupTasksDisabledWarning);
  });
});
