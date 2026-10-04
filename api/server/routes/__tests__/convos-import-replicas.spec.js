const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { buildChatGptExportZip, cleanupChatGptExportZips } = require('~/test/chatgptExport');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { CacheKeys, FileSources } = require('librechat-data-provider');

jest.mock('~/server/middleware/requireJwtAuth', () => (req, res, next) => next());
jest.mock('~/server/middleware', () => ({
  createImportLimiters: () => ({
    importIpLimiter: (req, res, next) => next(),
    importUserLimiter: (req, res, next) => next(),
  }),
  createForkLimiters: () => ({
    forkIpLimiter: (req, res, next) => next(),
    forkUserLimiter: (req, res, next) => next(),
  }),
  configMiddleware: (req, res, next) => next(),
  validateConvoAccess: (req, res, next) => next(),
}));
jest.mock('~/server/utils/import/defaults', () => ({
  resolveImportDefaultModel: jest.fn().mockResolvedValue('gpt-4o-mini'),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({ saveBuffer: jest.fn() })),
}));

/** Counts launches. The subject here is which replica is allowed to launch a
 * run at all, so the run itself is stubbed: a real one over these fixtures
 * would assert nothing this file is about. */
const mockRun = jest.fn(async () => ({ imported: 0, skipped: 0, failed: 0, errors: [] }));
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return { ...actual, runImport: (...args) => mockRun(...args) };
});

const { ImportJobStore } = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');

/**
 * Sends a Supertest request now and resolves with its response. Building one
 * with `request(app).post(...)` does not send it: nothing leaves the process
 * until the request is subscribed to, so awaiting anything that depends on the
 * route having been entered would wait for a request that was never made.
 * `.end()` dispatches it, which is what makes the interleaving below ordered
 * rather than a race this suite would sometimes lose.
 */
function dispatch(test) {
  return new Promise((resolve, reject) => {
    test.end((err, res) => (err ? reject(err) : resolve(res)));
  });
}

/**
 * Holds the next read of the job store open, so a second replica can complete
 * a whole confirmation inside the window the first one is holding. Gated
 * rather than timed: the point is the interleaving, and a sleep long enough to
 * be reliable on a loaded CI box is a sleep this suite pays on every run.
 */
function gateNextRead(store) {
  const read = store.get.bind(store);
  let reached;
  let open;
  const reading = new Promise((resolve) => (reached = resolve));
  const gate = new Promise((resolve) => (open = resolve));
  let gated = true;
  let released = false;

  store.get = async (key) => {
    const value = await read(key);
    if (gated) {
      gated = false;
      reached();
      await gate;
    }
    return value;
  };

  return {
    reading,
    /** Idempotent so the cleanup below can release a gate a failing test left
     * armed without having to know whether the test got that far itself. */
    release: () => {
      if (released) {
        return;
      }
      released = true;
      store.get = read;
      reached();
      open();
    },
  };
}

/** Gates the confirmation write after its final read, at the stale-snapshot
 * boundary that allowed cancellation to be overwritten before mutations
 * shared one cross-replica claim. */
function gateNextWrite(store) {
  const write = store.set.bind(store);
  let reached;
  let open;
  const writing = new Promise((resolve) => (reached = resolve));
  const gate = new Promise((resolve) => (open = resolve));
  let gated = true;
  let released = false;

  store.set = async (...args) => {
    if (gated) {
      gated = false;
      reached();
      await gate;
    }
    return write(...args);
  };

  return {
    writing,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      store.set = write;
      reached();
      open();
    },
  };
}

async function waitForTerminal(app, jobId) {
  for (let i = 0; i < 80; i++) {
    const status = await request(app).get(`/api/convos/import/jobs/${jobId}`);
    if (['completed', 'failed', 'cancelled'].includes(status.body.phase)) {
      return status.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Import job ${jobId} never reached a terminal phase`);
}

/**
 * The confirmation transition seen from a deployment running more than one
 * replica against one shared job store. The router under test is one replica;
 * `otherReplica` is a second `ImportJobStore` over the very same namespace,
 * which is the whole of what a second container shares with this one. The
 * namespace is given `SET NX` claim helpers because that is what the
 * Redis-backed namespace the server runs on provides and the in-memory
 * fallback, being private to one process, does not.
 */
describe('import confirmation across replicas', () => {
  let app;
  let mongoServer;
  let userId;
  let jobStore;
  let otherReplica;
  let grantClaim;
  let activeGate = null;
  const claims = new Map();
  const uploadDirs = [];

  /** Arms the gate and registers it, so a test that fails before releasing it
   * cannot leave the shared store wrapped for whatever runs next. */
  function armGate() {
    activeGate = gateNextRead(jobStore);
    return activeGate;
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const models = createModels(mongoose);
    Object.assign(mongoose.models, models);
    await createMethods(mongoose).seedDefaultRoles();

    const convosRouter = require('../convos');

    app = express();
    app.use((req, res, next) => {
      req.user = { id: userId, role: 'USER' };
      const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-replica-uploads-'));
      uploadDirs.push(uploadsDir);
      req.config = {
        paths: { uploads: uploadsDir },
        fileStrategy: FileSources.local,
        interfaceConfig: {},
      };
      next();
    });
    app.use('/api/convos', convosRouter);

    /** The same object the router resolved: `standardCache` memoizes its
     * in-memory namespaces, so this is that replica's job store, not a copy. */
    jobStore = getLogStores(CacheKeys.IMPORT_JOBS);
    let issued = 0;
    grantClaim = async (key) => {
      if (claims.has(key)) {
        return null;
      }
      const token = `claim-${(issued += 1)}`;
      claims.set(key, token);
      return token;
    };
    jobStore.acquireLock = grantClaim;
    jobStore.releaseLock = async (key, token) => {
      if (claims.get(key) === token) {
        claims.delete(key);
      }
    };
    jobStore.setIfLockOwned = async (lockKey, key, token, value, ttl) => {
      if (claims.get(lockKey) !== token) {
        return false;
      }
      await jobStore.set(key, value, ttl);
      return true;
    };
    otherReplica = new ImportJobStore(jobStore);
  });

  afterAll(async () => {
    const collections = mongoose.connection.collections;
    for (const key in collections) {
      await collections[key].deleteMany({});
    }
    await mongoose.disconnect();
    await mongoServer.stop();
    for (const dir of uploadDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupChatGptExportZips();
    delete jobStore.acquireLock;
    delete jobStore.releaseLock;
    delete jobStore.setIfLockOwned;
  });

  beforeEach(() => {
    userId = new mongoose.Types.ObjectId().toString();
    mockRun.mockClear();
    claims.clear();
    jobStore.acquireLock = grantClaim;
  });

  afterEach(() => {
    activeGate?.release();
    activeGate = null;
  });

  async function uploadJob() {
    const filepath = await buildChatGptExportZip();
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    return uploaded.body.jobId;
  }

  it('refuses the start of a job another replica has already claimed', async () => {
    const jobId = await uploadJob();

    const claimed = await otherReplica.confirmStart(userId, jobId);
    const refused = await request(app).post(`/api/convos/import/jobs/${jobId}/start`).expect(409);

    expect(claimed.status).toBe('started');
    expect(refused.body.message).toBe('Import job is not awaiting confirmation');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('makes the losing replica retry while the winner is still writing and launches once', async () => {
    const jobId = await uploadJob();
    /** Consumed by the route's own confirmation read, so the second replica
     * answers from inside the window where the store still holds
     * `awaiting_confirmation`: exactly the interleaving that used to let both
     * replicas start the same archive. */
    const gate = armGate();

    const started = dispatch(request(app).post(`/api/convos/import/jobs/${jobId}/start`));
    await gate.reading;
    const loser = await otherReplica.confirmStart(userId, jobId);
    gate.release();

    expect(loser.status).toBe('lock_unavailable');
    expect((await started).status).toBe(202);
    await waitForTerminal(app, jobId);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  /**
   * The store that hands out claims is the same Redis every replica shares, so
   * "it raised" is a live possibility, not a hypothetical. Starting anyway
   * would be fail-open: no replica could tell whether another was confirming
   * the same job, which is precisely the duplicate-start race the claim exists
   * to close, and it would be open for exactly as long as Redis is unwell.
   */
  it('refuses the start and launches nothing when the claim cannot be taken', async () => {
    const jobId = await uploadJob();
    jobStore.acquireLock = async () => {
      throw new Error('Redis unavailable');
    };

    const refused = await request(app).post(`/api/convos/import/jobs/${jobId}/start`).expect(503);

    expect(refused.headers['retry-after']).toBe('60');
    expect(mockRun).not.toHaveBeenCalled();
    const polled = await request(app).get(`/api/convos/import/jobs/${jobId}`).expect(200);
    expect(polled.body.phase).toBe('awaiting_confirmation');
  });

  it('starts the job on the retry the refusal invites', async () => {
    const jobId = await uploadJob();
    jobStore.acquireLock = async () => {
      throw new Error('Redis unavailable');
    };
    await request(app).post(`/api/convos/import/jobs/${jobId}/start`).expect(503);

    jobStore.acquireLock = grantClaim;
    await request(app).post(`/api/convos/import/jobs/${jobId}/start`).expect(202);

    await waitForTerminal(app, jobId);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('refuses cancellation without deleting or launching when the claim is unavailable', async () => {
    const jobId = await uploadJob();
    const job = await otherReplica.get(userId, jobId);
    jobStore.acquireLock = async () => {
      throw new Error('Redis unavailable');
    };

    const refused = await request(app).delete(`/api/convos/import/jobs/${jobId}`).expect(503);

    expect(refused.headers['retry-after']).toBe('60');
    expect(fs.existsSync(job.filepath)).toBe(true);
    expect(mockRun).not.toHaveBeenCalled();
    const polled = await request(app).get(`/api/convos/import/jobs/${jobId}`).expect(200);
    expect(polled.body.phase).toBe('awaiting_confirmation');
  });

  it('does not delete an upload that confirmation has already committed to starting', async () => {
    const jobId = await uploadJob();
    const job = await otherReplica.get(userId, jobId);
    const writeGate = gateNextWrite(jobStore);
    activeGate = writeGate;
    let finishRun;
    let announceRun;
    const runStarted = new Promise((resolve) => (announceRun = resolve));
    mockRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          announceRun();
          finishRun = () => resolve({ imported: 0, skipped: 0, failed: 0, errors: [] });
        }),
    );

    const starting = dispatch(request(app).post(`/api/convos/import/jobs/${jobId}/start`));
    await writeGate.writing;
    const cancelling = dispatch(request(app).delete(`/api/convos/import/jobs/${jobId}`));
    writeGate.release();

    expect((await starting).status).toBe(202);
    expect((await cancelling).status).toBe(200);
    await runStarted;
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(job.filepath)).toBe(true);
    expect((await otherReplica.get(userId, jobId)).status).toBe('cancelled');

    finishRun();
    await waitForTerminal(app, jobId);
    expect((await otherReplica.get(userId, jobId)).status).toBe('cancelled');
  });

  it('still refuses a start for a job another replica cancelled', async () => {
    const jobId = await uploadJob();

    const cancelled = await otherReplica.cancel(userId, jobId);
    const refused = await request(app).post(`/api/convos/import/jobs/${jobId}/start`).expect(409);

    expect(cancelled).toEqual({ status: 'cancelled', previousPhase: 'awaiting_confirmation' });
    expect(refused.body.message).toBe('Import job is not awaiting confirmation');
    expect(mockRun).not.toHaveBeenCalled();
  });
});
