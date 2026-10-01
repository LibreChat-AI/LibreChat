const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { buildChatGptExportZip, cleanupChatGptExportZips } = require('~/test/chatgptExport');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { ImportJobStore } = require('@librechat/api');

/** One stage at a time, so a single running import puts the node at capacity
 * and the next request has to be refused rather than admitted. */
process.env.CONVERSATION_IMPORT_MAX_CONCURRENT = '1';

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

const mockLegacy = { release: null, started: null };
jest.mock('~/server/utils/import', () => ({
  importConversations: jest.fn(
    () =>
      new Promise((resolve) => {
        mockLegacy.started?.();
        mockLegacy.release = resolve;
      }),
  ),
}));

/** Holds the run open. Everything else in the package stays real: the point
 * is to observe the ceiling while a genuine run occupies its slot, and a run
 * over these fixtures finishes far too quickly to observe otherwise. */
const mockRun = { release: null };
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    runImport: jest.fn(
      () =>
        new Promise((resolve) => {
          mockRun.release = () => resolve({ imported: 0, skipped: 0, failed: 0, errors: [] });
        }),
    ),
  };
});

/** Waits for the mocked run to be entered, i.e. for the job to hold the slot. */
async function waitForRunStart() {
  for (let i = 0; i < 40; i++) {
    if (mockRun.release) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The import run never started');
}

/** Lets the held run finish and waits until its job reports completion, so the
 * slot it held is free before the next test uploads. */
async function finishRun(app, jobId, ownerId, setUser) {
  setUser(ownerId);
  mockRun.release();
  for (let i = 0; i < 40; i++) {
    const status = await request(app).get(`/api/convos/import/jobs/${jobId}`);
    if (status.body.phase === 'completed') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The import run never completed');
}

describe('import concurrency ceiling', () => {
  let app;
  let mongoServer;
  let userId;
  const uploadDirs = [];

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
      const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-cap-uploads-'));
      uploadDirs.push(uploadsDir);
      req.config = {
        paths: { uploads: uploadsDir },
        fileStrategy: FileSources.local,
        interfaceConfig: {},
      };
      next();
    });
    app.use('/api/convos', convosRouter);
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
    delete process.env.CONVERSATION_IMPORT_MAX_CONCURRENT;
  });

  beforeEach(() => {
    userId = new mongoose.Types.ObjectId().toString();
    mockRun.release = null;
    mockLegacy.release = null;
    mockLegacy.started = null;
  });

  /** The per-user limit lets a second account through; the node-wide ceiling
   * is what keeps two exports from being parsed in one heap at once. */
  it("refuses a second user's upload while the node is at capacity, and admits it once the run ends", async () => {
    const filepath = await buildChatGptExportZip();

    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    await waitForRunStart();

    const owner = userId;
    userId = new mongoose.Types.ObjectId().toString();
    const refused = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(429);
    expect(refused.body.message).toBe('Too many imports are running, try again shortly');

    userId = owner;
    mockRun.release();

    for (let i = 0; i < 40; i++) {
      const status = await request(app).get(`/api/convos/import/jobs/${uploaded.body.jobId}`);
      if (status.body.phase === 'completed') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await request(app).post('/api/convos/import').attach('file', filepath).expect(202);
  });

  it('keeps a legacy import inside the process-wide capacity slot', async () => {
    const legacyStarted = new Promise((resolve) => {
      mockLegacy.started = resolve;
    });
    const legacy = request(app)
      .post('/api/convos/import')
      .attach('file', Buffer.from('{"version":1,"history":[]}'), 'legacy.json');

    const legacyResponse = legacy.then((response) => response);
    await legacyStarted;

    userId = new mongoose.Types.ObjectId().toString();
    const filepath = await buildChatGptExportZip();
    await request(app).post('/api/convos/import').attach('file', filepath).expect(429);

    mockLegacy.release();
    expect((await legacyResponse).status).toBe(201);
  });

  /** Checked after multer, a refused request had already streamed its whole
   * body to the temp volume the ceiling exists to protect. */
  it('refuses an upload at capacity before writing any of its body to disk', async () => {
    const filepath = await buildChatGptExportZip();
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    await waitForRunStart();
    const owner = userId;

    userId = new mongoose.Types.ObjectId().toString();
    await request(app).post('/api/convos/import').attach('file', filepath).expect(429);

    const refusedUploads = path.join(uploadDirs[uploadDirs.length - 1], 'temp', userId);
    expect(fs.existsSync(refusedUploads) ? fs.readdirSync(refusedUploads) : []).toEqual([]);

    await finishRun(app, uploaded.body.jobId, owner, (id) => (userId = id));
  });

  it('gives the stage back when the upload itself is rejected', async () => {
    await request(app)
      .post('/api/convos/import')
      .attach('file', Buffer.from('plain text'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(415);

    const filepath = await buildChatGptExportZip();
    const admitted = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    expect(admitted.body.jobId).toEqual(expect.any(String));
  });

  /** A start refused for capacity must not write the job at all: a rollback
   * write that failed would strand it as `queued`, unstartable until it expired. */
  it('refuses a start at capacity without touching the waiting job', async () => {
    const filepath = await buildChatGptExportZip();
    const waiting = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    const waitingOwner = userId;

    userId = new mongoose.Types.ObjectId().toString();
    const runningOwner = userId;
    const running = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${running.body.jobId}/start`).expect(202);
    await waitForRunStart();

    userId = waitingOwner;
    const confirmStart = jest.spyOn(ImportJobStore.prototype, 'confirmStart');
    const patch = jest.spyOn(ImportJobStore.prototype, 'patch');
    try {
      const refused = await request(app)
        .post(`/api/convos/import/jobs/${waiting.body.jobId}/start`)
        .expect(429);
      expect(refused.body.message).toBe('Too many imports are running, try again shortly');
      expect(confirmStart).not.toHaveBeenCalled();
      expect(patch).not.toHaveBeenCalled();
    } finally {
      confirmStart.mockRestore();
      patch.mockRestore();
    }

    const job = await request(app).get(`/api/convos/import/jobs/${waiting.body.jobId}`).expect(200);
    expect(job.body.phase).toBe('awaiting_confirmation');

    await finishRun(app, running.body.jobId, runningOwner, (id) => (userId = id));
  });
});
