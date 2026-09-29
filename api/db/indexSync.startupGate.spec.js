/**
 * The startup task gate over the search index sync in `api/db/indexSync.js`.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.13, 12.14
 *
 * The observations are the ones the criteria name. Reads of `conversations` and `messages` come
 * from the connection's own `operation-start` event, so the real models issue the real queries
 * against a real (in-memory) MongoDB. Outbound MeiliSearch traffic is counted at `fetch`, the
 * boundary where the MeiliSearch client would otherwise need a server: nothing in the client is
 * replaced, and a suppressed sync is one that never reaches the boundary at all.
 *
 * Nothing else in `api/db/indexSync.js`'s dependency graph is substituted — the real
 * `areStartupTasksDisabled()` from `@librechat/api` decides the suppression, and the real flows
 * cache carries the flow state.
 *
 * `searchEnabled` in `api/db/indexSync.js` is a module-scope constant frozen at require time, so
 * each `SEARCH` value needs its own module instance. The per-call assertion for criterion 12.3
 * deliberately stays inside one instance and changes only the flag, which is what distinguishes a
 * per-call read of the environment from one frozen at module load.
 *
 * The `warn`-level line the gate emits per boot belongs to the entrypoints; task 14.2 owns it and
 * the suites that assert it, so nothing here asserts on it.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');
const { overrideEnv } = require('~/test/helpers/startup');

const MEILI_HOST = 'http://meili.test:7700';

/** The two collections criterion 12.1 requires a gated container to leave unread. */
const SEARCH_COLLECTIONS = Object.freeze(['conversations', 'messages']);

/** Environment shared by every case; each case sets `SEARCH` and the flag for itself. */
const BASE_ENV = Object.freeze({
  MEILI_HOST,
  MEILI_MASTER_KEY: 'test-master-key',
  MEILI_NO_SYNC: undefined,
  MEILI_SYNC_THRESHOLD: '1000',
  SEARCH: undefined,
  DISABLE_STARTUP_TASKS: undefined,
});

/** Answers a MeiliSearch request the way a reachable server would, without a server. */
function meiliResponseFor(pathname) {
  if (pathname === '/health') {
    return { status: 'available' };
  }
  if (pathname.endsWith('/settings')) {
    return { filterableAttributes: ['user'] };
  }
  if (pathname.endsWith('/search')) {
    return {
      hits: [],
      query: '',
      processingTimeMs: 0,
      limit: 20,
      offset: 0,
      estimatedTotalHits: 0,
    };
  }
  return {};
}

/**
 * Records every outbound request and answers it locally. `meilisearch` resolves the global
 * `fetch` at call time, so the spy covers the client the sync builds for itself.
 */
function observeMeiliRequests() {
  const requests = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    return new Response(JSON.stringify(meiliResponseFor(url.pathname)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return requests;
}

/** Waits until no new outbound request has been recorded for `quietMs`, then clears the record. */
async function settleMeiliRequests(requests, { quietMs = 100, timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = requests.length;
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (requests.length !== seen) {
      seen = requests.length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= quietMs) {
      break;
    }
  }

  requests.length = 0;
}

describe('Startup task gate over the search index sync', () => {
  /* Each case loads its own module instance, which re-requires the model and cache graphs. */
  jest.setTimeout(60_000);

  let mongoServer;
  let mongoUri;
  let restoreEnv;
  let meiliRequests;
  /** @type {Array<{ stop: () => Promise<void> }>} */
  let instances;

  /**
   * Loads one `api/db/indexSync.js` instance with the given environment, against real models on a
   * real connection. `SEARCH` is applied before the require because the module freezes it there.
   */
  async function loadIndexSync({ startupTasksDisabled, search }) {
    jest.resetModules();

    if (startupTasksDisabled === undefined) {
      delete process.env.DISABLE_STARTUP_TASKS;
    } else {
      process.env.DISABLE_STARTUP_TASKS = startupTasksDisabled;
    }
    process.env.SEARCH = search;

    const mongoose = require('mongoose');
    await mongoose.connect(mongoUri, { autoIndex: false, autoCreate: false });
    /* Registers `Conversation` and `Message` with the search plugin attached, which is what gives
     * them the sync statics `indexSync()` calls. */
    require('~/db/models');

    /* Each instance attaches its own `exit` listener for the sync's timeout cleanup; teardown drops
     * the ones this suite caused so several instances in one worker leave no listener behind. */
    const exitListenersBefore = new Set(process.listeners('exit'));
    const indexSync = require('./indexSync');
    const exitListeners = process
      .listeners('exit')
      .filter((candidate) => !exitListenersBefore.has(candidate));

    const operations = [];
    const listener = ({ collectionName, method }) => operations.push({ collectionName, method });
    mongoose.connection.on('operation-start', listener);

    const instance = {
      indexSync,
      operations,
      readsOf: (collectionName) =>
        operations.filter((operation) => operation.collectionName === collectionName),
      stop: async () => {
        mongoose.connection.off('operation-start', listener);
        for (const exitListener of exitListeners) {
          process.off('exit', exitListener);
        }
        await mongoose.disconnect();
      },
    };

    instances.push(instance);
    /* Model registration attaches the search plugin, whose own provisioning is not what these
     * cases measure; drain its traffic before the window opens. */
    await settleMeiliRequests(meiliRequests);
    operations.length = 0;
    return instance;
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    mongoUri = mongoServer.getUri();
  });

  beforeEach(() => {
    instances = [];
    restoreEnv = overrideEnv(BASE_ENV);
    /* `clearMocks` wipes implementations between tests, so the stub is installed per test. */
    meiliRequests = observeMeiliRequests();
  });

  afterEach(async () => {
    for (const instance of instances) {
      await instance.stop();
    }
    restoreEnv();
  });

  afterAll(async () => {
    await mongoServer.stop();
  });

  it('issues no read and no MeiliSearch request when the flag is set and search is enabled', async () => {
    const { indexSync, operations, readsOf } = await loadIndexSync({
      startupTasksDisabled: 'true',
      search: 'true',
    });

    await expect(indexSync()).resolves.toBeUndefined();

    for (const collectionName of SEARCH_COLLECTIONS) {
      expect(readsOf(collectionName)).toEqual([]);
    }
    expect(operations).toEqual([]);
    expect(meiliRequests).toEqual([]);
  });

  it('issues no read and no MeiliSearch request when the flag is set and search is disabled', async () => {
    const { indexSync, operations, readsOf } = await loadIndexSync({
      startupTasksDisabled: 'true',
      search: 'false',
    });

    await expect(indexSync()).resolves.toBeUndefined();

    for (const collectionName of SEARCH_COLLECTIONS) {
      expect(readsOf(collectionName)).toEqual([]);
    }
    expect(operations).toEqual([]);
    expect(meiliRequests).toEqual([]);
  });

  it('runs the sync when the flag is unset and search is enabled', async () => {
    const { indexSync, readsOf } = await loadIndexSync({
      startupTasksDisabled: undefined,
      search: 'true',
    });

    await indexSync();

    for (const collectionName of SEARCH_COLLECTIONS) {
      expect(readsOf(collectionName).length).toBeGreaterThan(0);
    }
    expect(meiliRequests).toContain('/health');
  });

  it('issues no read and no MeiliSearch request when the flag is unset and search is disabled', async () => {
    const { indexSync, operations, readsOf } = await loadIndexSync({
      startupTasksDisabled: undefined,
      search: 'false',
    });

    await expect(indexSync()).resolves.toBeUndefined();

    for (const collectionName of SEARCH_COLLECTIONS) {
      expect(readsOf(collectionName)).toEqual([]);
    }
    expect(operations).toEqual([]);
    expect(meiliRequests).toEqual([]);
  });

  it('reads the flag on every call rather than at module load', async () => {
    const { indexSync, operations, readsOf } = await loadIndexSync({
      startupTasksDisabled: 'true',
      search: 'true',
    });

    await indexSync();

    expect(operations).toEqual([]);
    expect(meiliRequests).toEqual([]);

    /* Same module instance, so `searchEnabled` is still the `true` it froze at require time and
     * the flag is the only thing that changed. */
    delete process.env.DISABLE_STARTUP_TASKS;
    await indexSync();

    for (const collectionName of SEARCH_COLLECTIONS) {
      expect(readsOf(collectionName).length).toBeGreaterThan(0);
    }
    expect(meiliRequests).toContain('/health');
  });
});
