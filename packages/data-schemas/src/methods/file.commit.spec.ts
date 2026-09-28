import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { CodeFileCommitData, IMongoFile } from '~/types/file';
import { createFileMethods } from './file';
import fileSchema from '~/schema/file';

describe('Code output commits', () => {
  let mongo: MongoMemoryServer;
  let methods: ReturnType<typeof createFileMethods>;
  let File: mongoose.Model<IMongoFile>;
  const userId = new mongoose.Types.ObjectId().toString();

  function fileData(overrides: Partial<CodeFileCommitData> = {}): CodeFileCommitData {
    return {
      file_id: uuidv4(),
      user: userId,
      tenantId: 'tenant-a',
      conversationId: 'conversation-a',
      messageId: 'message-a',
      filename: 'report.csv',
      filepath: '/uploads/report.csv',
      bytes: 12,
      type: 'text/csv',
      source: FileSources.local,
      context: FileContext.execute_code,
      ...overrides,
    };
  }

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    File = mongoose.model('File', fileSchema);
    await File.init();
    methods = createFileMethods(mongoose);
  });

  beforeEach(async () => {
    await File.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel('File');
    await mongo.stop();
  });

  it('creates foreground output without an upload TTL from plain file data', async () => {
    const data = fileData({
      createdAt: new Date('2026-09-12T10:00:00Z'),
      updatedAt: '2026-09-12T10:01:00Z',
      expiredAt: new Date('2026-09-19T10:00:00Z'),
      text: null,
      textFormat: null,
      status: null,
      previewError: null,
      previewRevision: null,
    });

    expect(await methods.commitCodeFile(data)).toBe(true);

    const stored = await File.findOne({ file_id: data.file_id }).lean();
    expect(stored?.user.toString()).toBe(userId);
    expect(stored).toMatchObject({
      file_id: data.file_id,
      filename: data.filename,
      filepath: data.filepath,
      messageId: data.messageId,
      expiredAt: data.expiredAt,
      text: null,
      textFormat: null,
      status: null,
      previewError: null,
      previewRevision: null,
    });
    expect(stored?.expiresAt).toBeUndefined();
    expect(stored?.createdAt).toBeInstanceOf(Date);
  });

  it('updates foreground output unconditionally and preserves existing upsert TTL semantics', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const data = fileData({
      metadata: { sourceDispatchedAt: 200 },
      text: 'old preview',
      textFormat: 'html',
      status: 'ready',
      previewRevision: 'old-revision',
    });
    await File.create({ ...data, expiresAt });

    expect(
      await methods.commitCodeFile({
        ...data,
        filepath: '/uploads/foreground.csv',
        metadata: { sourceDispatchedAt: 100 },
        text: null,
        textFormat: null,
        status: null,
        previewRevision: null,
      }),
    ).toBe(true);

    const stored = await File.findOne({ file_id: data.file_id }).lean();
    expect(stored).toMatchObject({
      filepath: '/uploads/foreground.csv',
      metadata: { sourceDispatchedAt: 100 },
      text: null,
      textFormat: null,
      status: null,
      previewRevision: null,
      expiresAt,
    });
    expect(await File.countDocuments()).toBe(1);
  });

  it.each([
    ['absent', undefined],
    ['earlier', 100],
    ['equal', 200],
  ] as const)(
    'commits over an %s dispatch stamp and removes the upload TTL',
    async (_label, stamp) => {
      const data = fileData({
        metadata: stamp == null ? undefined : { sourceDispatchedAt: stamp },
      });
      await File.create({ ...data, expiresAt: new Date(Date.now() + 3_600_000) });

      expect(
        await methods.commitCodeFile(
          {
            ...data,
            filepath: '/uploads/background.csv',
            metadata: { sourceDispatchedAt: 200 },
          },
          200,
        ),
      ).toBe(true);

      const stored = await File.findOne({ file_id: data.file_id }).lean();
      expect(stored).toMatchObject({
        filepath: '/uploads/background.csv',
        metadata: { sourceDispatchedAt: 200 },
      });
      expect(stored?.expiresAt).toBeUndefined();
    },
  );

  it('rejects an output overtaken after its claim without changing the current bytes or TTL', async () => {
    const data = fileData();
    await methods.claimCodeFile({
      filename: data.filename,
      conversationId: data.conversationId!,
      file_id: data.file_id,
      user: userId,
      tenantId: data.tenantId,
      sourceDispatchedAt: 100,
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await File.updateOne(
      { file_id: data.file_id },
      {
        $set: {
          filepath: '/uploads/newer.csv',
          'metadata.sourceDispatchedAt': 200,
          expiresAt,
        },
      },
    );

    expect(
      await methods.commitCodeFile({ ...data, metadata: { sourceDispatchedAt: 100 } }, 100),
    ).toBe(false);

    expect(await File.findOne({ file_id: data.file_id }).lean()).toMatchObject({
      filepath: '/uploads/newer.csv',
      metadata: { sourceDispatchedAt: 200 },
      expiresAt,
    });
  });

  it.each([0, 200])(
    'does not recreate an absent claimed row for dispatch stamp %s',
    async (stamp) => {
      expect(
        await methods.commitCodeFile(fileData({ metadata: { sourceDispatchedAt: stamp } }), stamp),
      ).toBe(false);
      expect(await File.countDocuments()).toBe(0);
    },
  );

  it('keeps the latest dispatch when competing background writes commit concurrently', async () => {
    const data = fileData({ metadata: { sourceDispatchedAt: 0 } });
    await File.create(data);

    const [, newer] = await Promise.all(
      [100, 200].map((stamp) =>
        methods.commitCodeFile(
          {
            ...data,
            filepath: `/uploads/${stamp}.csv`,
            metadata: { sourceDispatchedAt: stamp },
          },
          stamp,
        ),
      ),
    );

    expect(newer).toBe(true);
    expect(await File.findOne({ file_id: data.file_id }).lean()).toMatchObject({
      filepath: '/uploads/200.csv',
      metadata: { sourceDispatchedAt: 200 },
    });
    expect(await File.countDocuments()).toBe(1);
  });
});
