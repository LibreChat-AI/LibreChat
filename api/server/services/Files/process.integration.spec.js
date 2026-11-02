/**
 * Integration test for the delete-time path of issue #12776.
 *
 * Covers the full flow through `processDeleteRequest`:
 *   1. Real Agent + File docs in an in-memory Mongo.
 *   2. Invoke the delete service.
 *   3. Assert both the File record is gone and every agent's
 *      tool_resources.*.file_ids no longer references the deleted id.
 *
 * Uses FileSources.text so the strategy layer (disk / S3 / OpenAI) is a
 * no-op — we don't need real filesystem access to exercise the agent
 * reference cleanup, which is what issue #12776 is about.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { agentSchema, fileSchema, createMethods } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  };
});

jest.mock('@librechat/agents', () => ({
  EnvVar: { CODE_API_KEY: 'CODE_API_KEY' },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../../../packages/api/src/files/finalize'),
  sanitizeFilename: jest.fn((n) => n),
  parseText: jest.fn().mockResolvedValue({ text: '', bytes: 0 }),
  processAudioFile: jest.fn(),
}));

jest.mock('~/server/controllers/assistants/v2', () => ({
  addResourceFileId: jest.fn(),
  deleteResourceFileId: jest.fn(),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({ deleteFile: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock('~/server/services/Files/Audio/STTService', () => ({
  STTService: { getInstance: jest.fn() },
}));

jest.mock('~/server/services/Config', () => ({
  checkCapability: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({ get: jest.fn(), set: jest.fn(), delete: jest.fn() })),
}));

// Replace the mocked `~/models` from the sibling process.spec.js with real,
// mongoose-backed methods. All our in-memory models share this module.
jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  return createMethods(mongoose, {
    removeAllPermissions: jest.fn().mockResolvedValue(undefined),
  });
});

require('module-alias/register');
const { processDeleteRequest } = require('./process');

describe('processDeleteRequest — agent reference cleanup (issue #12776)', () => {
  let mongoServer;
  let Agent;
  let File;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    // createMethods (via ~/models) registers the File model as a side-effect,
    // but we also need the Agent model registered before any queries run.
    Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
    File = mongoose.models.File || mongoose.model('File', fileSchema);
    // Touch createMethods once so the migration/setup side-effects run.
    createMethods(mongoose, { removeAllPermissions: jest.fn() });
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Agent.deleteMany({});
    await File.deleteMany({});
  });

  const seedFile = async (file_id, userId) =>
    File.create({
      file_id,
      user: userId,
      filename: `${file_id}.txt`,
      filepath: `/tmp/${file_id}`,
      object: 'file',
      type: 'text/plain',
      bytes: 1,
      source: FileSources.text,
    });

  const seedAgent = async (authorId, tool_resources) =>
    Agent.create({
      id: `agent_${Math.random().toString(36).slice(2, 10)}`,
      name: 'Integration Test Agent',
      provider: 'test',
      model: 'test-model',
      author: authorId,
      tool_resources,
    });

  const buildReq = (fileDocs, extraBody = {}) => ({
    user: { id: fileDocs[0].user.toString() },
    body: { files: fileDocs, ...extraBody },
    config: { fileStrategy: 'local', fileConfig: {}, endpoints: {} },
  });

  test('strips deleted file_ids from every agent that referenced them', async () => {
    const userId = new mongoose.Types.ObjectId();
    const keeperId = `file_keeper_${Math.random().toString(36).slice(2, 10)}`;
    const deletedId = `file_deleted_${Math.random().toString(36).slice(2, 10)}`;

    const deletedFile = await seedFile(deletedId, userId);
    await seedFile(keeperId, userId);

    // Two agents both reference the file that's about to be deleted, plus the
    // keeper. A third, unrelated agent has a different file_id and must not be
    // touched by the cleanup.
    const agentA = await seedAgent(userId, {
      file_search: { file_ids: [deletedId, keeperId] },
    });
    const agentB = await seedAgent(userId, {
      execute_code: { file_ids: [deletedId] },
    });
    const untouchedAgent = await seedAgent(userId, {
      context: { file_ids: [keeperId] },
    });

    await processDeleteRequest({ req: buildReq([deletedFile.toObject()]), files: [deletedFile] });

    expect(await File.findOne({ file_id: deletedId })).toBeNull();
    expect(await File.findOne({ file_id: keeperId })).not.toBeNull();

    const updatedA = await Agent.findOne({ id: agentA.id }).lean();
    const updatedB = await Agent.findOne({ id: agentB.id }).lean();
    const updatedUntouched = await Agent.findOne({ id: untouchedAgent.id }).lean();

    expect(updatedA.tool_resources.file_search.file_ids).toEqual([keeperId]);
    expect(updatedB.tool_resources.execute_code.file_ids).toEqual([]);
    expect(updatedUntouched.tool_resources.context.file_ids).toEqual([keeperId]);
  });

  test('is a no-op when no agent references the deleted file', async () => {
    const userId = new mongoose.Types.ObjectId();
    const loneId = `file_lone_${Math.random().toString(36).slice(2, 10)}`;
    const loneFile = await seedFile(loneId, userId);
    const unrelatedAgent = await seedAgent(userId, {
      file_search: { file_ids: ['other_id'] },
    });

    await processDeleteRequest({ req: buildReq([loneFile.toObject()]), files: [loneFile] });

    expect(await File.findOne({ file_id: loneId })).toBeNull();
    const after = await Agent.findOne({ id: unrelatedAgent.id }).lean();
    expect(after.tool_resources.file_search.file_ids).toEqual(['other_id']);
  });

  test('still deletes the file when the agent cleanup step throws', async () => {
    const userId = new mongoose.Types.ObjectId();
    const targetId = `file_target_${Math.random().toString(36).slice(2, 10)}`;
    const targetFile = await seedFile(targetId, userId);

    const db = require('~/models');
    const original = db.removeAgentResourceFilesFromAllAgents;
    db.removeAgentResourceFilesFromAllAgents = jest
      .fn()
      .mockRejectedValue(new Error('simulated cleanup failure'));

    try {
      await processDeleteRequest({ req: buildReq([targetFile.toObject()]), files: [targetFile] });
      expect(await File.findOne({ file_id: targetId })).toBeNull();
    } finally {
      db.removeAgentResourceFilesFromAllAgents = original;
    }
  });
});
