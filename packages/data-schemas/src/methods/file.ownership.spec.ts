import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { IMongoFile } from '~/types/file';
import { createFileStorageMethods } from './fileStorage';
import { createFileMethods } from './file';
import fileSchema from '~/schema/file';

let mongo: MongoMemoryServer;
let File: mongoose.Model<IMongoFile>;
let methods: ReturnType<typeof createFileMethods>;
let storage: ReturnType<typeof createFileStorageMethods>;
const user = new mongoose.Types.ObjectId();
const data = {
  file_id: 'ownership-file',
  user,
  tenantId: 'tenant-a',
  filename: 'notes.pdf',
  filepath: '/uploads/notes.pdf',
  type: 'application/pdf',
  bytes: 12,
  source: FileSources.local,
  context: FileContext.agents,
};
const claim = {
  file_id: data.file_id,
  userId: user.toString(),
  tenantId: data.tenantId,
  token: 'search',
};
const read = () => File.findOne({ file_id: data.file_id }).lean();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  File = mongoose.model('File', fileSchema);
  await File.init();
  methods = createFileMethods(mongoose);
  storage = createFileStorageMethods(mongoose);
});
beforeEach(async () => {
  await File.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  mongoose.deleteModel('File');
  await mongo?.stop();
});

it('marks only a newly inserted file as completely tracked', async () => {
  const file = await methods.createFile(data, true);
  expect(file?.embeddingOwnersComplete).toBe(true);
  await methods.updateFile({ ...data, metadata: { destinationChosen: true } });
  expect((await read())?.embeddingOwnersComplete).toBe(true);
});

it.each([undefined, false])(
  'never promotes a legacy upsert or update (%s)',
  async (embeddingOwnersComplete) => {
    await File.create({
      ...data,
      embedded: true,
      metadata: { embeddedEntities: ['agent-a'] },
      embeddingOwnersComplete,
    });
    await methods.createFile({ ...data, embeddingOwnersComplete: true }, true);
    await methods.updateFile({ ...data, embeddingOwnersComplete: true });
    expect((await read())?.embeddingOwnersComplete).toBe(embeddingOwnersComplete);
  },
);

it('keeps partial legacy adoption incomplete through provisioning and refuses reconciliation', async () => {
  await File.create({ ...data, embedded: true });
  await methods.adoptLegacySearchEmbeddings({
    files: [{ file_id: data.file_id, user: user.toString(), tenantId: data.tenantId }],
    agentId: 'agent-a',
  });
  expect(await storage.acquireFileProvision(claim)).toBe(true);
  expect(await storage.commitFileProvision({ claim, embedded: true, entityId: 'agent-c' })).toBe(
    true,
  );
  const file = await read();
  expect(file?.metadata?.embeddedEntities).toEqual(['agent-a', 'agent-c']);
  expect(file?.embeddingOwnersComplete).toBeUndefined();
  expect(
    await methods.clearFileEmbeddings({
      ...claim,
      updatedAt: file?.updatedAt,
      embeddedEntities: ['agent-a', 'agent-c'],
    }),
  ).toBe(false);
  expect((await read())?.embedded).toBe(true);
  expect((await read())?.metadata?.embeddedEntities).toEqual(['agent-a', 'agent-c']);
});

it('preserves complete tracking across additive provisioning and verified cleanup', async () => {
  await methods.createFile(data, true);
  expect(await storage.acquireFileProvision(claim)).toBe(true);
  expect(await storage.commitFileProvision({ claim, embedded: true, entityId: 'agent-a' })).toBe(
    true,
  );
  expect(await storage.commitFileProvision({ claim, embedded: true, entityId: 'agent-b' })).toBe(
    true,
  );
  const file = await read();
  expect(file?.embeddingOwnersComplete).toBe(true);
  expect(
    await methods.clearFileEmbeddings({
      ...claim,
      updatedAt: file?.updatedAt,
      embeddedEntities: ['agent-a', 'agent-b'],
    }),
  ).toBe(true);
  expect((await read())?.embeddingOwnersComplete).toBe(true);
  expect((await read())?.embedded).toBe(false);
});

it('does not promote a reused generated-output claim', async () => {
  const code = { ...data, context: FileContext.execute_code, conversationId: 'conversation' };
  await File.create(code);
  await methods.claimCodeFile({ ...code, user: user.toString() });
  expect((await read())?.embeddingOwnersComplete).toBeUndefined();
});

it('marks newly claimed generated output complete before deferred embeddings', async () => {
  const file = await methods.claimCodeFile({
    file_id: data.file_id,
    user: user.toString(),
    tenantId: data.tenantId,
    filename: 'output.csv',
    conversationId: 'conversation',
  });
  expect(file.embeddingOwnersComplete).toBe(true);
});

it.each(['create', 'update', 'output'] as const)(
  'preserves owners added after a stale %s metadata snapshot',
  async (writer) => {
    const original = await methods.createFile(
      { ...data, embedded: true, metadata: { embeddedEntities: ['agent-a'] } },
      true,
    );
    await methods.addFileEmbeddedEntity({ file_id: data.file_id, entityId: 'agent-b' });
    const stale = { ...data, metadata: original?.metadata };
    if (writer === 'create') await methods.createFile(stale, true);
    else if (writer === 'update') await methods.updateFile(stale);
    else {
      expect(await storage.acquireFileProvision(claim)).toBe(true);
      expect(
        await storage.commitFileProvision({
          claim,
          output: { file: { ...stale, user: user.toString() } },
        }),
      ).toBe(true);
    }
    const current = await read();
    expect(current?.metadata?.embeddedEntities).toEqual(['agent-a', 'agent-b']);
    expect(current?.embeddingOwnersComplete).toBe(true);
  },
);
