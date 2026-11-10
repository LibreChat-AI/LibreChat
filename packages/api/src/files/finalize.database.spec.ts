import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IAgent, IMongoFile } from '@librechat/data-schemas';
import { finalizeFileDeletion } from './finalize';

let mongo: MongoMemoryServer;
let File: mongoose.Model<IMongoFile>;
let Agent: mongoose.Model<IAgent>;
let methods: ReturnType<typeof createMethods>;
const logger = { error: jest.fn() };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  createModels(mongoose);
  await mongoose.connect(mongo.getUri());
  File = mongoose.models.File as mongoose.Model<IMongoFile>;
  Agent = mongoose.models.Agent as mongoose.Model<IAgent>;
  methods = createMethods(mongoose);
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await File.deleteMany({});
  await Agent.deleteMany({});
  logger.error.mockClear();
});

const seedFile = (file_id: string, user: mongoose.Types.ObjectId) =>
  File.create({
    file_id,
    user,
    filename: `${file_id}.txt`,
    filepath: `/uploads/${file_id}`,
    type: 'text/plain',
    bytes: 1,
    source: 'text',
  });

const seedAgent = (file_ids: string[]) =>
  Agent.create({
    id: `agent_${new mongoose.Types.ObjectId().toString()}`,
    name: 'Agent',
    provider: 'test',
    model: 'test-model',
    author: new mongoose.Types.ObjectId(),
    tool_resources: { file_search: { file_ids } },
  });

const referencedIds = async (agent: IAgent) =>
  (await Agent.findOne({ id: agent.id }).lean())?.tool_resources?.file_search?.file_ids;

const deleteFilesOf = (files: IMongoFile[]) =>
  finalizeFileDeletion(
    {
      deletedFileIds: files.map((file) => file.file_id),
      failedFileIds: [],
      files: files.map((file) => file.toObject()),
      userId: files[0].user.toString(),
    },
    {
      deleteFiles: methods.deleteFiles,
      removeAgentResourceFilesFromAllAgents: methods.removeAgentResourceFilesFromAllAgents,
      logger,
    },
  );

it('keeps the agent references of another owner who holds the same file_id', async () => {
  const ownerId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  const ownerFile = await seedFile('shared', ownerId);
  await seedFile('shared', otherId);
  const otherAgent = await seedAgent(['shared']);

  expect(await deleteFilesOf([ownerFile])).toEqual({
    deletedFileIds: ['shared'],
    failedFileIds: [],
  });

  expect(await File.countDocuments({ file_id: 'shared', user: ownerId })).toBe(0);
  expect(await File.countDocuments({ file_id: 'shared', user: otherId })).toBe(1);
  expect(await referencedIds(otherAgent)).toEqual(['shared']);
  expect(logger.error).not.toHaveBeenCalled();
});

it('drops the agent references once the last holder deletes the file', async () => {
  const ownerFile = await seedFile('shared', new mongoose.Types.ObjectId());
  const otherFile = await seedFile('shared', new mongoose.Types.ObjectId());
  const agent = await seedAgent(['shared']);

  await deleteFilesOf([ownerFile]);
  expect(await referencedIds(agent)).toEqual(['shared']);

  await deleteFilesOf([otherFile]);
  expect(await referencedIds(agent)).toEqual([]);
});

it('drops the references of the ids in a batch that no other File document holds', async () => {
  const ownerId = new mongoose.Types.ObjectId();
  const sharedFile = await seedFile('shared', ownerId);
  const soloFile = await seedFile('solo', ownerId);
  await seedFile('shared', new mongoose.Types.ObjectId());
  const agent = await seedAgent(['shared', 'solo']);

  expect(await deleteFilesOf([sharedFile, soloFile])).toEqual({
    deletedFileIds: ['shared', 'solo'],
    failedFileIds: [],
  });

  expect(await referencedIds(agent)).toEqual(['shared']);
});
