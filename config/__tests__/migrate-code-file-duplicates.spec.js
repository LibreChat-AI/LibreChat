const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { FileContext } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Mock the config/connect module to prevent connection attempts during tests
jest.mock('../connect', () => jest.fn().mockResolvedValue(true));

// Disable console for tests
logger.silent = true;

describe('Code File Duplicate Migration Script', () => {
  let mongoServer;
  let File;
  let migrateCodeFileDuplicates;

  /** The unique partial index this migration exists to unblock. */
  const INDEX_KEYS = { filename: 1, conversationId: 1, context: 1, tenantId: 1 };
  const INDEX_NAME = 'filename_1_conversationId_1_context_1_tenantId_1';
  const INDEX_OPTIONS = {
    unique: true,
    partialFilterExpression: { context: FileContext.execute_code },
  };

  /**
   * Reproduces the state this migration is written for: legacy duplicates
   * present and the unique index absent because its build failed. Mongoose
   * builds schema indexes in the background at startup, so without dropping it
   * here the fixtures would race an index the affected deployments don't have.
   */
  async function dropUniqueIndex() {
    await File.init().catch(() => {
      /* the background build may itself fail — that IS the scenario */
    });
    await File.collection.dropIndex(INDEX_NAME).catch(() => {
      /* already absent */
    });
  }

  async function createCodeFile({ filename, conversationId, createdAt, context }) {
    return File.create({
      user: new mongoose.Types.ObjectId(),
      file_id: uuidv4(),
      filename,
      filepath: `/images/user/${uuidv4()}.png`,
      object: 'file',
      type: 'image/png',
      bytes: 1024,
      conversationId,
      context: context ?? FileContext.execute_code,
      createdAt,
      updatedAt: createdAt,
    });
  }

  const namesFor = async (conversationId) => {
    const files = await File.find({ conversationId }).lean();
    return files.map((file) => file.filename).sort();
  };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const dbModels = require('~/db/models');
    File = dbModels.File;

    ({ migrateCodeFileDuplicates } = require('../migrate-code-file-duplicates'));

    await dropUniqueIndex();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await File.deleteMany({});
    await File.collection.dropIndex(INDEX_NAME).catch(() => {
      /* the test never built it */
    });
  });

  it('renames older duplicates and leaves the newest record canonical', async () => {
    const conversationId = uuidv4();
    await createCodeFile({
      filename: 'bar_chart.png',
      conversationId,
      createdAt: new Date('2025-03-29T03:54:53Z'),
    });
    await createCodeFile({
      filename: 'bar_chart.png',
      conversationId,
      createdAt: new Date('2025-03-29T03:56:32Z'),
    });

    const result = await migrateCodeFileDuplicates({ dryRun: false });

    expect(result.duplicateGroups).toBe(1);
    expect(result.filesRenamed).toBe(1);
    /* Newest keeps the canonical name — the claim path's "latest write wins". */
    expect(await namesFor(conversationId)).toEqual(['bar_chart (1).png', 'bar_chart.png']);
    const newest = await File.findOne({ filename: 'bar_chart.png' }).lean();
    expect(newest.createdAt).toEqual(new Date('2025-03-29T03:56:32Z'));
  });

  it('never deletes: every original record survives the rename', async () => {
    const conversationId = uuidv4();
    const older = await createCodeFile({
      filename: 'plot.png',
      conversationId,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    const newer = await createCodeFile({
      filename: 'plot.png',
      conversationId,
      createdAt: new Date('2025-01-01T00:05:00Z'),
    });

    await migrateCodeFileDuplicates({ dryRun: false });

    /* Both file_ids still resolve — a deleted record would strip a real
     * artifact out of the message attachment that references it. */
    expect(await File.countDocuments({})).toBe(2);
    const kept = await File.findOne({ file_id: older.file_id }).lean();
    expect(kept).not.toBeNull();
    expect(kept.filepath).toBe(older.filepath);
    expect((await File.findOne({ file_id: newer.file_id }).lean()).filename).toBe('plot.png');
  });

  it('unblocks the unique partial index that could not build before', async () => {
    const conversationId = uuidv4();
    await createCodeFile({
      filename: 'report.png',
      conversationId,
      createdAt: new Date('2025-02-01T00:00:00Z'),
    });
    await createCodeFile({
      filename: 'report.png',
      conversationId,
      createdAt: new Date('2025-02-01T00:01:00Z'),
    });

    /* Precondition: the duplicates genuinely block the build (E11000). */
    await expect(File.collection.createIndex(INDEX_KEYS, INDEX_OPTIONS)).rejects.toThrow();

    const result = await migrateCodeFileDuplicates({ dryRun: false });

    expect(result.indexBuilt).toBe(true);
    const indexes = await File.collection.indexes();
    expect(
      indexes.some((index) => index.name === 'filename_1_conversationId_1_context_1_tenantId_1'),
    ).toBe(true);
  });

  it('reports without writing in dry-run mode', async () => {
    const conversationId = uuidv4();
    await createCodeFile({
      filename: 'chart.png',
      conversationId,
      createdAt: new Date('2025-04-01T00:00:00Z'),
    });
    await createCodeFile({
      filename: 'chart.png',
      conversationId,
      createdAt: new Date('2025-04-01T00:02:00Z'),
    });

    const result = await migrateCodeFileDuplicates({ dryRun: true });

    expect(result.filesRenamed).toBe(1);
    expect(result.indexBuilt).toBe(false);
    expect(await namesFor(conversationId)).toEqual(['chart.png', 'chart.png']);
  });

  it('skips names already taken in the conversation', async () => {
    const conversationId = uuidv4();
    await createCodeFile({
      filename: 'out.png',
      conversationId,
      createdAt: new Date('2025-05-01T00:00:00Z'),
    });
    await createCodeFile({
      filename: 'out.png',
      conversationId,
      createdAt: new Date('2025-05-01T00:01:00Z'),
    });
    /* An unrelated record already occupies the first replacement name. */
    await createCodeFile({
      filename: 'out (1).png',
      conversationId,
      createdAt: new Date('2025-05-01T00:03:00Z'),
    });

    await migrateCodeFileDuplicates({ dryRun: false });

    expect(await namesFor(conversationId)).toEqual(['out (1).png', 'out (2).png', 'out.png']);
  });

  it('resolves three copies into distinct names in one pass', async () => {
    const conversationId = uuidv4();
    for (const minute of [0, 1, 2]) {
      await createCodeFile({
        filename: 'fig.png',
        conversationId,
        createdAt: new Date(`2025-06-01T00:0${minute}:00Z`),
      });
    }

    const result = await migrateCodeFileDuplicates({ dryRun: false });

    expect(result.filesRenamed).toBe(2);
    expect(await namesFor(conversationId)).toEqual(['fig (1).png', 'fig (2).png', 'fig.png']);
    expect(result.indexBuilt).toBe(true);
  });

  it('leaves same-named files in DIFFERENT conversations alone', async () => {
    const first = uuidv4();
    const second = uuidv4();
    await createCodeFile({
      filename: 'shared.png',
      conversationId: first,
      createdAt: new Date('2025-07-01T00:00:00Z'),
    });
    await createCodeFile({
      filename: 'shared.png',
      conversationId: second,
      createdAt: new Date('2025-07-01T00:01:00Z'),
    });

    const result = await migrateCodeFileDuplicates({ dryRun: false });

    expect(result.duplicateGroups).toBe(0);
    expect(result.filesRenamed).toBe(0);
    expect(await namesFor(first)).toEqual(['shared.png']);
    expect(await namesFor(second)).toEqual(['shared.png']);
  });

  it('ignores duplicates outside the execute_code context', async () => {
    const conversationId = uuidv4();
    await createCodeFile({
      filename: 'upload.png',
      conversationId,
      createdAt: new Date('2025-08-01T00:00:00Z'),
      context: FileContext.message_attachment,
    });
    await createCodeFile({
      filename: 'upload.png',
      conversationId,
      createdAt: new Date('2025-08-01T00:01:00Z'),
      context: FileContext.message_attachment,
    });

    const result = await migrateCodeFileDuplicates({ dryRun: false });

    /* The index is partial — only code outputs must be unique. */
    expect(result.duplicateGroups).toBe(0);
    expect(await namesFor(conversationId)).toEqual(['upload.png', 'upload.png']);
  });

  it('is safe to re-run once each conversation is unique', async () => {
    const conversationId = uuidv4();
    await createCodeFile({
      filename: 'idempotent.png',
      conversationId,
      createdAt: new Date('2025-09-01T00:00:00Z'),
    });
    await createCodeFile({
      filename: 'idempotent.png',
      conversationId,
      createdAt: new Date('2025-09-01T00:01:00Z'),
    });

    await migrateCodeFileDuplicates({ dryRun: false });
    const afterFirst = await namesFor(conversationId);

    const second = await migrateCodeFileDuplicates({ dryRun: false });

    expect(second.duplicateGroups).toBe(0);
    expect(second.filesRenamed).toBe(0);
    expect(await namesFor(conversationId)).toEqual(afterFirst);
  });

  it('handles filenames without an extension', async () => {
    const conversationId = uuidv4();
    await createCodeFile({
      filename: 'Makefile',
      conversationId,
      createdAt: new Date('2025-10-01T00:00:00Z'),
    });
    await createCodeFile({
      filename: 'Makefile',
      conversationId,
      createdAt: new Date('2025-10-01T00:01:00Z'),
    });

    await migrateCodeFileDuplicates({ dryRun: false });

    expect(await namesFor(conversationId)).toEqual(['Makefile', 'Makefile (1)']);
  });
});
