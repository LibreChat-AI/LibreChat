/**
 * Boots the `api/server/index.js` entrypoint once as the auth surface — `DISABLE_STARTUP_TASKS`
 * set, `MONGO_AUTO_CREATE` and `MONGO_AUTO_INDEX` false — with pre-relocation documents already
 * sitting in `tokens` and in `logs`, and asserts the boot moves none of them into `authtokens` or
 * into `bans`. Neither relocation ships a startup migration, so both source collections must come
 * out of the boot exactly as they went in.
 *
 * Requirements: 1.10, 1.11, 8.27
 */
const request = require('supertest');
const mongoose = require('mongoose');
const {
  captureLogLines,
  observeDatabaseOperations,
  observeHttpServers,
  overrideEnv,
  startInMemoryMongo,
  stubClientAssets,
  stubOutboundFetch,
  waitFor,
} = require('~/test/helpers/startup');
const {
  documentWrites,
  readRelocationPairs,
  seedLegacyDocuments,
} = require('~/test/helpers/relocation');

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

describe('Relocation boot path on the auth surface, startup tasks gated', () => {
  jest.setTimeout(60_000);

  let mongoServer;
  let database;
  let logLines;
  let httpServers;
  let seeded;
  let state;

  beforeAll(async () => {
    stubClientAssets();
    mongoServer = await startInMemoryMongo();
    seeded = await seedLegacyDocuments(process.env.MONGO_URI);

    database = observeDatabaseOperations();
    logLines = captureLogLines();
    stubOutboundFetch();
    httpServers = observeHttpServers();

    const app = require('~/server');

    await waitFor(async () => (await request(app).get('/readyz')).status === 200, {
      message: '/readyz to report ready',
      logLines,
    });

    logLines.endBootWindow();
    state = await readRelocationPairs();
  });

  afterAll(async () => {
    database.stop();
    await httpServers.stop();
    await mongoose.disconnect();
    await mongoServer.stop();
    restoreEnv();
  });

  it('leaves every seeded `tokens` document in place', () => {
    expect(state.tokens).toEqual(seeded.tokens);
  });

  it('copies no `tokens` document into `authtokens`', () => {
    expect(state.authtokens).toEqual([]);
    expect(state.collectionNames).not.toContain('authtokens');
    expect(documentWrites(database.operations, 'authtokens')).toEqual([]);
  });

  it('leaves every seeded `logs` ban entry in place', () => {
    expect(state.logs).toEqual(seeded.logs);
  });

  it('copies no `logs` document into `bans`', () => {
    expect(state.bans).toEqual([]);
    expect(state.collectionNames).not.toContain('bans');
    expect(documentWrites(database.operations, 'bans')).toEqual([]);
  });
});
