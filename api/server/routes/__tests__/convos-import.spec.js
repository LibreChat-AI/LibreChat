const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const multer = require('multer');
const JSZip = require('jszip');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  buildChatGptExportZip,
  buildMixedAssetExportZip,
  cleanupChatGptExportZips,
} = require('~/test/chatgptExport');
const {
  bareClaudeExport,
  buildClaudeExportZip,
  cleanupClaudeExportZips,
} = require('~/test/claudeExport');
const { bareGrokExport, buildGrokExportZip, cleanupGrokExportZips } = require('~/test/grokExport');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { ImportJobStore } = require('@librechat/api');
const { FileSources, EModelEndpoint } = require('librechat-data-provider');

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
/** Every `saveBuffer` the job pipeline issued, so a test can assert which
 * storage base path each asset type was written under. */
const mockSavedAssets = [];
const mockDeletedAssets = [];
/**
 * The real local storage strategy writes under the repo's `client/public`
 * tree. This route test only cares that the job pipeline calls `saveBuffer`
 * and persists the resulting filepath, so it substitutes a strategy that
 * writes assets into a throwaway temp directory instead of the real repo.
 */
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: async ({ buffer, fileName, basePath }) => {
      mockSavedAssets.push({ fileName, basePath });
      const nodeFs = require('fs');
      const nodePath = require('path');
      const nodeOs = require('os');
      const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lc-import-assets-'));
      const filepath = nodePath.join(dir, fileName);
      nodeFs.writeFileSync(filepath, buffer);
      return filepath;
    },
    deleteFile: async (req, file) => {
      mockDeletedAssets.push({ req, file });
    },
  })),
}));

const importFileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/json') {
    cb(null, true);
  } else {
    cb(new Error('Only JSON files are allowed'), false);
  }
};

/** Proxy app that mirrors the production multer + error-handling pattern */
function createImportApp(fileSize) {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: importFileFilter,
    limits: { fileSize },
  });
  const uploadSingle = upload.single('file');

  function handleUpload(req, res, next) {
    uploadSingle(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ message: 'File exceeds the maximum allowed size' });
      }
      if (err) {
        return next(err);
      }
      next();
    });
  }

  app.post('/import', handleUpload, (req, res) => {
    res.status(201).json({ message: 'success', size: req.file.size });
  });

  app.use((err, _req, res, _next) => {
    res.status(400).json({ error: err.message });
  });

  return app;
}

describe('Conversation Import - Multer File Size Limits', () => {
  describe('multer rejects files exceeding the configured limit', () => {
    it('returns 413 for files larger than the limit', async () => {
      const limit = 1024;
      const app = createImportApp(limit);
      const oversized = Buffer.alloc(limit + 512, 'x');

      const res = await request(app)
        .post('/import')
        .attach('file', oversized, { filename: 'import.json', contentType: 'application/json' });

      expect(res.status).toBe(413);
      expect(res.body.message).toBe('File exceeds the maximum allowed size');
    });

    it('accepts files within the limit', async () => {
      const limit = 4096;
      const app = createImportApp(limit);
      const valid = Buffer.from(JSON.stringify({ title: 'test' }));

      const res = await request(app)
        .post('/import')
        .attach('file', valid, { filename: 'import.json', contentType: 'application/json' });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe('success');
    });

    it('rejects at the exact boundary (limit + 1 byte)', async () => {
      const limit = 512;
      const app = createImportApp(limit);
      const boundary = Buffer.alloc(limit + 1, 'a');

      const res = await request(app)
        .post('/import')
        .attach('file', boundary, { filename: 'import.json', contentType: 'application/json' });

      expect(res.status).toBe(413);
    });

    it('accepts a file just under the limit', async () => {
      const limit = 512;
      const app = createImportApp(limit);
      const underLimit = Buffer.alloc(limit - 1, 'b');

      const res = await request(app)
        .post('/import')
        .attach('file', underLimit, { filename: 'import.json', contentType: 'application/json' });

      expect(res.status).toBe(201);
    });
  });
});

const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled']);

/** Waits for a job to reach a terminal phase, polling the real job store through the route. */
async function waitForTerminal(app, jobId, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const res = await request(app).get(`/api/convos/import/jobs/${jobId}`);
    if (TERMINAL_PHASES.has(res.body.phase)) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Job ${jobId} never reached a terminal phase`);
}

/** The single archive stored for a user under the request's upload dir. */
function storedUpload(uploadsDir, userId) {
  const dir = path.join(uploadsDir, 'temp', userId);
  const [name] = fs.readdirSync(dir);
  return path.join(dir, name);
}

function bareChatGptExport() {
  return Buffer.from(
    JSON.stringify([
      {
        conversation_id: 'ext-bare',
        title: 'Bare export',
        create_time: 1700000000,
        update_time: 1700000100,
        default_model_slug: 'gpt-4o',
        is_archived: false,
        is_starred: false,
        pinned_time: null,
        mapping: {
          root: { id: 'root', message: null, parent: null, children: ['u1'] },
          u1: {
            id: 'u1',
            parent: 'root',
            children: [],
            message: {
              id: 'u1',
              author: { role: 'user', name: null },
              create_time: 1700000001,
              content: { content_type: 'text', parts: ['Hello'] },
            },
          },
        },
      },
    ]),
  );
}

function chatbotUiExport(content = 'Hi') {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      history: [
        {
          model: { id: 'gpt-4o-mini' },
          name: 'Chatbot UI convo',
          messages: [
            { role: 'user', content },
            { role: 'assistant', content: 'Hello!' },
          ],
        },
      ],
    }),
  );
}

async function zippedLegacyExport(name = 'exports/chatbotui.json', content) {
  const zip = new JSZip();
  zip.file(name, chatbotUiExport(content));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('conversation import job API (real router, real Mongo)', () => {
  let app;
  let mongoServer;
  let Conversation;
  let User;
  let userId;
  const uploadDirs = [];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const models = createModels(mongoose);
    Object.assign(mongoose.models, models);
    Conversation = models.Conversation;
    User = models.User;

    const methods = createMethods(mongoose);
    await methods.seedDefaultRoles();

    const convosRouter = require('../convos');

    app = express();
    app.use((req, res, next) => {
      req.user = { id: userId, role: 'USER' };
      const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-uploads-'));
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
    cleanupClaudeExportZips();
    cleanupGrokExportZips();
  });

  beforeEach(async () => {
    await Conversation.deleteMany({});
    await User.deleteMany({});
    userId = new mongoose.Types.ObjectId().toString();
    mockDeletedAssets.length = 0;
    await User.create({ _id: userId, username: 'importer', email: 'importer@test.com' });
  });

  it('accepts a zip, returns a job awaiting confirmation, then runs it', async () => {
    const filepath = await buildChatGptExportZip();

    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    expect(uploaded.body.jobId).toBeDefined();
    expect(uploaded.body.summary.conversations).toBe(2);
    expect(uploaded.body.summary.assets).toBe(3);

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);

    const status = await request(app)
      .get(`/api/convos/import/jobs/${uploaded.body.jobId}`)
      .expect(200);

    expect(['queued', 'assets', 'conversations', 'completed']).toContain(status.body.phase);
    expect(status.body.filepath).toBeUndefined();
    expect(status.body.userId).toBeUndefined();

    const completed = await waitForTerminal(app, uploaded.body.jobId);
    expect(completed.body.phase).toBe('completed');
    expect(completed.body.report.imported).toBe(2);

    const savedConvos = await Conversation.countDocuments({ user: userId });
    expect(savedConvos).toBe(2);
  });

  it('starts archive sweep eligibility when the inspected job is created', async () => {
    const filepath = await buildChatGptExportZip();
    const uploadIndex = uploadDirs.length;
    const realCreate = ImportJobStore.prototype.create;
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const createSpy = jest
      .spyOn(ImportJobStore.prototype, 'create')
      .mockImplementation(function (input) {
        fs.utimesSync(input.filepath, oldTime, oldTime);
        return realCreate.call(this, input);
      });

    try {
      await request(app).post('/api/convos/import').attach('file', filepath).expect(202);

      const storedFilepath = storedUpload(uploadDirs[uploadIndex], userId);
      expect(fs.statSync(storedFilepath).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      createSpy.mockRestore();
    }
  });

  /** `client/public/images` is served statically, and authentication over it
   * is off unless `secureImageLinks` is enabled, so an imported PDF or audio
   * file written to the strategy's default base would be anonymously
   * retrievable by URL. Only images, which already render from that tree,
   * belong there. */
  it('writes non-image assets under uploads and images under images', async () => {
    mockSavedAssets.length = 0;
    const filepath = await buildMixedAssetExportZip();

    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);

    const completed = await waitForTerminal(app, uploaded.body.jobId);
    expect(completed.body.phase).toBe('completed');

    const basePathFor = (suffix) =>
      mockSavedAssets.find((call) => call.fileName.endsWith(suffix))?.basePath;
    expect(basePathFor('photo.jpg')).toBe('images');
    expect(basePathFor('voice.wav')).toBe('uploads');
  });

  it('rejects a file that is neither json nor zip', async () => {
    const rejected = await request(app)
      .post('/api/convos/import')
      .attach('file', Buffer.from('nope'), 'notes.txt')
      .expect(415);

    expect(rejected.body.message).toBe('Unsupported import type');

    expect(rejected.body.jobId).toBeUndefined();
  });

  it('404s a job belonging to another user', async () => {
    const missing = await request(app).get('/api/convos/import/jobs/does-not-exist').expect(404);

    expect(missing.body.message).toBe('Import job not found');
  });

  it("scopes jobs by user: another user gets 404, not the first user's job", async () => {
    const filepath = await buildChatGptExportZip();
    const owner = userId;
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    userId = new mongoose.Types.ObjectId().toString();
    const denied = await request(app)
      .get(`/api/convos/import/jobs/${uploaded.body.jobId}`)
      .expect(404);
    expect(denied.body.message).toBe('Import job not found');

    userId = owner;
    const visible = await request(app)
      .get(`/api/convos/import/jobs/${uploaded.body.jobId}`)
      .expect(200);
    expect(visible.body.jobId).toBe(uploaded.body.jobId);
  });

  it('imports a bare ChatGPT .json upload through the job API, matching the zip pipeline', async () => {
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', bareChatGptExport(), 'bare-export.json')
      .expect(202);

    expect(uploaded.body.jobId).toBeDefined();
    expect(uploaded.body.summary.conversations).toBe(1);
    expect(uploaded.body.summary.source).toBe('chatgpt-legacy');

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, uploaded.body.jobId);
    expect(completed.body.phase).toBe('completed');
    expect(completed.body.report.imported).toBe(1);

    const savedConvos = await Conversation.countDocuments({ user: userId });
    expect(savedConvos).toBe(1);
  });

  it('keeps an extensionless MIME-only ChatGPT upload in the job pipeline', async () => {
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', bareChatGptExport(), {
        filename: 'bare-export',
        contentType: 'application/json',
      })
      .expect(202);

    expect(uploaded.body.jobId).toBeDefined();
    expect(uploaded.body.summary).toMatchObject({ source: 'chatgpt-legacy', conversations: 1 });

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, uploaded.body.jobId);
    expect(completed.body.phase).toBe('completed');
    expect(await Conversation.countDocuments({ user: userId })).toBe(1);
  });

  it('continues importing when a progress-only job-store write fails', async () => {
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', bareChatGptExport(), 'bare-export.json')
      .expect(202);
    const realPatchProgress = ImportJobStore.prototype.patchProgress;
    let injectedFailure = false;
    const patchSpy = jest
      .spyOn(ImportJobStore.prototype, 'patchProgress')
      .mockImplementation(function (owner, jobId, progress) {
        if (!injectedFailure) {
          injectedFailure = true;
          return Promise.reject(new Error('transient progress cache failure'));
        }
        return realPatchProgress.call(this, owner, jobId, progress);
      });

    try {
      await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
      const completed = await waitForTerminal(app, uploaded.body.jobId);

      expect(injectedFailure).toBe(true);
      expect(completed.body.phase).toBe('completed');
      expect(completed.body.report.imported).toBe(1);
      expect(await Conversation.countDocuments({ user: userId })).toBe(1);
    } finally {
      patchSpy.mockRestore();
    }
  });

  it('stores the final progress snapshot when every intermediate write is throttled', async () => {
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', bareChatGptExport(), 'bare-export.json')
      .expect(202);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1);

    try {
      await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
      const completed = await waitForTerminal(app, uploaded.body.jobId);

      expect(completed.body.phase).toBe('completed');
      expect(completed.body.progress.conversations).toEqual({ done: 1, total: 1 });
      expect(completed.body.progress.messages.done).toBeGreaterThan(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('imports a Claude export .zip through the job API', async () => {
    const filepath = await buildClaudeExportZip();

    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    expect(uploaded.body.summary).toMatchObject({
      source: 'claude',
      conversations: 2,
      assets: 0,
      archived: 0,
      starred: 0,
    });

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, uploaded.body.jobId);

    expect(completed.body.phase).toBe('completed');
    expect(completed.body.report.imported).toBe(2);
    expect(completed.body.report.errors).toEqual([]);

    const convos = await Conversation.find({ user: userId }).lean();
    expect(convos).toHaveLength(2);
    expect(convos.every((convo) => convo.endpoint === EModelEndpoint.anthropic)).toBe(true);
    expect(convos.map((convo) => convo.importedFrom.source).sort()).toEqual(['claude', 'claude']);
  });

  it('imports a bare Claude conversations.json upload through the same job API', async () => {
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', bareClaudeExport(), 'conversations.json')
      .expect(202);

    expect(uploaded.body.summary.source).toBe('claude');
    expect(uploaded.body.summary.conversations).toBe(2);

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, uploaded.body.jobId);

    expect(completed.body.phase).toBe('completed');
    expect(completed.body.report.imported).toBe(2);
    expect(await Conversation.countDocuments({ user: userId })).toBe(2);
  });

  it('skips a Claude conversation already imported and does not skip ChatGPT ids', async () => {
    const filepath = await buildClaudeExportZip();

    const first = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${first.body.jobId}/start`).expect(202);
    await waitForTerminal(app, first.body.jobId);

    const second = await request(app)
      .post('/api/convos/import')
      .attach('file', await buildClaudeExportZip())
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${second.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, second.body.jobId);

    expect(completed.body.report.imported).toBe(0);
    expect(completed.body.report.skipped).toBe(2);
    expect(await Conversation.countDocuments({ user: userId })).toBe(2);
  });

  it('imports a Grok export .zip through the job API on the OpenAI endpoint', async () => {
    const filepath = await buildGrokExportZip();

    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    expect(uploaded.body.summary).toMatchObject({
      source: 'grok',
      conversations: 2,
      assets: 0,
      archived: 0,
      starred: 1,
    });

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, uploaded.body.jobId);

    expect(completed.body.phase).toBe('completed');
    expect(completed.body.report.imported).toBe(2);
    expect(completed.body.report.errors).toEqual([]);

    const convos = await Conversation.find({ user: userId }).lean();
    expect(convos).toHaveLength(2);
    expect(convos.every((convo) => convo.endpoint === EModelEndpoint.openAI)).toBe(true);
    expect(convos.map((convo) => convo.importedFrom.source).sort()).toEqual(['grok', 'grok']);
    expect(convos.map((convo) => convo.title).sort()).toEqual([
      'Amalfi trip planning',
      'Recovering a cut-off script',
    ]);

    const messages = await mongoose.models.Message.find({ user: userId }).lean();
    /** Five of six responses: the aborted, textless generation is dropped. */
    expect(messages).toHaveLength(5);
    const branch = messages.find((message) => message.text === 'Positano.');
    expect(branch.sender).toBe('Grok 4.1 Thinking');
    expect(branch.model).toBe('grok-4-1-thinking-1129');
    expect(branch.isCreatedByUser).toBe(false);
    const completedScript = messages.find(
      (message) => message.text === 'Here is the completed script.',
    );
    const prompt = messages.find((message) => message.text === 'Complete this script.');
    expect(completedScript.parentMessageId).toBe(prompt.messageId);
  });

  it('imports a bare prod-grok-backend.json upload through the same job API', async () => {
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', bareGrokExport(), 'prod-grok-backend.json')
      .expect(202);

    expect(uploaded.body.summary.source).toBe('grok');
    expect(uploaded.body.summary.conversations).toBe(2);

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, uploaded.body.jobId);

    expect(completed.body.phase).toBe('completed');
    expect(completed.body.report.imported).toBe(2);
    expect(await Conversation.countDocuments({ user: userId })).toBe(2);
  });

  it('skips a Grok conversation already imported and keeps provider id namespaces apart', async () => {
    const first = await request(app)
      .post('/api/convos/import')
      .attach('file', await buildGrokExportZip())
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${first.body.jobId}/start`).expect(202);
    await waitForTerminal(app, first.body.jobId);

    const second = await request(app)
      .post('/api/convos/import')
      .attach('file', await buildGrokExportZip())
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${second.body.jobId}/start`).expect(202);
    const completed = await waitForTerminal(app, second.body.jobId);

    expect(completed.body.report.imported).toBe(0);
    expect(completed.body.report.skipped).toBe(2);

    /** A Claude import on top adds its own conversations rather than being
     * suppressed by the Grok external ids already recorded. */
    const claude = await request(app)
      .post('/api/convos/import')
      .attach('file', await buildClaudeExportZip())
      .expect(202);
    await request(app).post(`/api/convos/import/jobs/${claude.body.jobId}/start`).expect(202);
    const claudeDone = await waitForTerminal(app, claude.body.jobId);

    expect(claudeDone.body.report.imported).toBe(2);
    expect(await Conversation.countDocuments({ user: userId })).toBe(4);
  });

  it('still imports a ChatbotUI-shaped .json upload through the legacy synchronous path', async () => {
    const res = await request(app)
      .post('/api/convos/import')
      .attach('file', chatbotUiExport(), 'chatbotui-export.json')
      .expect(201);

    expect(res.body.message).toBe('Conversation(s) imported successfully');
    const savedConvos = await Conversation.countDocuments({ user: userId });
    expect(savedConvos).toBe(1);
  });

  it('imports a sole ChatbotUI JSON entry from a ZIP through the bounded legacy path', async () => {
    const res = await request(app)
      .post('/api/convos/import')
      .attach('file', await zippedLegacyExport(), 'chatbotui-export.zip')
      .expect(201);

    expect(res.body.message).toBe('Conversation(s) imported successfully');
    expect(await Conversation.countDocuments({ user: userId })).toBe(1);
  });

  it('accepts the ZIP workflow offered for a legacy JSON over the bare-file shard limit', async () => {
    const previousLimit = process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;
    process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES = '512';
    const content = 'x'.repeat(1024);

    try {
      const bare = await request(app)
        .post('/api/convos/import')
        .attach('file', chatbotUiExport(content), 'chatbotui-export.json')
        .expect(400);
      expect(bare.body.message).toMatch(/compress it into a \.zip/i);

      await request(app)
        .post('/api/convos/import')
        .attach('file', await zippedLegacyExport('chatbotui.json', content), 'chatbotui-export.zip')
        .expect(201);
      expect(await Conversation.countDocuments({ user: userId })).toBe(1);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES;
      } else {
        process.env.CONVERSATION_IMPORT_MAX_SHARD_SIZE_BYTES = previousLimit;
      }
    }
  });

  it('rejects traversal in a legacy ZIP and cleans up the upload', async () => {
    const uploadIndex = uploadDirs.length;
    const res = await request(app)
      .post('/api/convos/import')
      .attach('file', await zippedLegacyExport('../chatbotui.json'), 'chatbotui-export.zip')
      .expect(400);

    expect(res.body.message).toBe('The uploaded archive is corrupt or could not be read');
    const userDir = path.join(uploadDirs[uploadIndex], 'temp', userId);
    expect(fs.existsSync(userDir) ? fs.readdirSync(userDir) : []).toEqual([]);
  });

  it('returns a sanitized message, not the raw archive error, when a zip fails to open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-corrupt-'));
    const corrupt = path.join(dir, 'corrupt.zip');
    fs.writeFileSync(
      corrupt,
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not a real zip body')]),
    );

    const res = await request(app).post('/api/convos/import').attach('file', corrupt).expect(400);

    expect(typeof res.body.message).toBe('string');
    expect(res.body.message).not.toContain(dir);
    expect(res.body.message).not.toContain(corrupt);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never leaks the server upload path in job.error when the underlying file disappears before start', async () => {
    const beforeUpload = uploadDirs.length;
    const filepath = await buildChatGptExportZip();

    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    const requestUploadDir = uploadDirs[beforeUpload];
    const storedFilepath = storedUpload(requestUploadDir, userId);
    expect(fs.existsSync(storedFilepath)).toBe(true);
    fs.rmSync(storedFilepath);

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);

    const failed = await waitForTerminal(app, uploaded.body.jobId);
    expect(failed.body.phase).toBe('failed');
    expect(typeof failed.body.error).toBe('string');
    expect(failed.body.error).not.toContain(requestUploadDir);
    expect(failed.body.error).not.toContain(storedFilepath);
    expect(JSON.stringify(failed.body)).not.toContain(requestUploadDir);
  });

  it('marks the job failed and removes the temp file when job setup throws synchronously', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    getStrategyFunctions.mockImplementationOnce(() => {
      throw new Error('Invalid file source: boom');
    });

    const beforeUpload = uploadDirs.length;
    const filepath = await buildChatGptExportZip();
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    const requestUploadDir = uploadDirs[beforeUpload];
    const storedFilepath = storedUpload(requestUploadDir, userId);
    expect(fs.existsSync(storedFilepath)).toBe(true);

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);

    const failed = await waitForTerminal(app, uploaded.body.jobId);
    expect(failed.body.phase).toBe('failed');
    expect(typeof failed.body.error).toBe('string');
    expect(fs.existsSync(storedFilepath)).toBe(false);
  });

  it('supplies owner metadata when rolling back stored assets', async () => {
    const db = require('~/models');
    const createFile = jest.spyOn(db, 'createFile').mockRejectedValue(new Error('row failed'));
    const filepath = await buildMixedAssetExportZip();

    try {
      const uploaded = await request(app)
        .post('/api/convos/import')
        .attach('file', filepath)
        .expect(202);

      await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
      await waitForTerminal(app, uploaded.body.jobId);

      expect(mockDeletedAssets.length).toBeGreaterThan(0);
      for (const deleted of mockDeletedAssets) {
        expect(deleted.req.user).toEqual({ id: userId, tenantId: undefined });
        expect(deleted.file).toEqual(
          expect.objectContaining({ user: userId, tenantId: undefined }),
        );
      }
    } finally {
      createFile.mockRestore();
    }
  });

  it('cancels an inspected job, removes its temp archive, and 404s an unknown job', async () => {
    const beforeUpload = uploadDirs.length;
    const filepath = await buildChatGptExportZip();
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    const storedFilepath = storedUpload(uploadDirs[beforeUpload], userId);
    expect(fs.existsSync(storedFilepath)).toBe(true);

    const cancelled = await request(app)
      .delete(`/api/convos/import/jobs/${uploaded.body.jobId}`)
      .expect(200);
    expect(cancelled.body.jobId).toBe(uploaded.body.jobId);
    expect(fs.existsSync(storedFilepath)).toBe(false);

    const status = await request(app)
      .get(`/api/convos/import/jobs/${uploaded.body.jobId}`)
      .expect(200);
    expect(status.body.phase).toBe('cancelled');
    expect(status.body.status).toBe('cancelled');

    await request(app).delete('/api/convos/import/jobs/does-not-exist').expect(404);
  });

  it('never overwrites a cancelled job with a completed phase once the run returns', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    /** Slows asset ingestion so the cancel lands while the run is still in
     * flight, which is the window the completion patch used to overwrite. */
    getStrategyFunctions.mockImplementationOnce(() => ({
      saveBuffer: async ({ fileName }) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return `/tmp/${fileName}`;
      },
    }));

    const filepath = await buildChatGptExportZip();
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    await request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`).expect(202);
    await request(app).delete(`/api/convos/import/jobs/${uploaded.body.jobId}`).expect(200);

    const settled = await waitForTerminal(app, uploaded.body.jobId);
    expect(settled.body.phase).toBe('cancelled');
    expect(settled.body.status).toBe('cancelled');
  });

  it('stores same-named uploads under distinct paths so one job cannot clobber another', async () => {
    const beforeUpload = uploadDirs.length;
    const filepath = await buildChatGptExportZip();

    await request(app).post('/api/convos/import').attach('file', filepath).expect(202);
    await request(app).post('/api/convos/import').attach('file', filepath).expect(202);

    const [first] = fs.readdirSync(path.join(uploadDirs[beforeUpload], 'temp', userId));
    const [second] = fs.readdirSync(path.join(uploadDirs[beforeUpload + 1], 'temp', userId));

    expect(first).not.toBe('chatgpt-export.zip');
    expect(first).toMatch(/chatgpt-export\.zip$/);
    expect(first).not.toBe(second);
  });

  it('rejects a second /start call for the same job with 409 and does not double-run the import', async () => {
    const filepath = await buildChatGptExportZip();
    const uploaded = await request(app)
      .post('/api/convos/import')
      .attach('file', filepath)
      .expect(202);

    const [first, second] = await Promise.all([
      request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`),
      request(app).post(`/api/convos/import/jobs/${uploaded.body.jobId}/start`),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);

    await waitForTerminal(app, uploaded.body.jobId);
    const savedConvos = await Conversation.countDocuments({ user: userId });
    expect(savedConvos).toBe(2);
  });
});
