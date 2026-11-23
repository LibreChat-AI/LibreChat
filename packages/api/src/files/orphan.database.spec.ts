import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IAgent, IMongoFile } from '@librechat/data-schemas';
import { createRecordExists, recordAgentUpload } from './orphan';

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

const user = new mongoose.Types.ObjectId();

const seedAgent = (file_ids: string[]) =>
  Agent.create({
    id: `agent_${new mongoose.Types.ObjectId().toString()}`,
    name: 'Agent',
    provider: 'test',
    model: 'test-model',
    author: user,
    tool_resources: { file_search: { file_ids } },
  });

const fileInfo = (file_id: string) => ({
  file_id,
  user,
  filename: `${file_id}.txt`,
  filepath: `/uploads/${file_id}`,
  type: 'text/plain',
  bytes: 1,
  source: 'local',
});

const linkedIds = async (agent: IAgent) =>
  (await Agent.findOne({ id: agent.id }).lean())?.tool_resources?.file_search?.file_ids;

const upload = (
  agent: IAgent,
  file_id: string,
  createRecord: () => Promise<unknown>,
  deleteFile: jest.Mock,
) =>
  recordAgentUpload({
    cleanup: {
      stored: { file_id, filepath: `/uploads/${file_id}`, source: 'local' },
      resolveDeleteFile: () => deleteFile,
      recordExists: createRecordExists((id) => methods.findFileById(id)),
      req: { user: { id: user.toString() } },
      logger,
    },
    link: { agent_id: agent.id, tool_resource: 'file_search', file_id },
    addLink: methods.addAgentResourceFile,
    removeLinks: methods.removeAgentResourceFiles,
    createRecord,
  });

describe('recordAgentUpload against the database', () => {
  // @scenario:db-unlink-on-record-failure
  it('leaves no link to the new file when its record write fails', async () => {
    const agent = await seedAgent(['kept-file']);
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    await expect(
      upload(agent, 'new-file', () => Promise.reject(new Error('db down')), deleteFile),
    ).rejects.toThrow('db down');

    expect(await linkedIds(agent)).toEqual(['kept-file']);
    expect(await File.countDocuments({ file_id: 'new-file' })).toBe(0);
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  // @scenario:db-keep-link-when-record-committed
  it('keeps the link when the rejected record write committed', async () => {
    const agent = await seedAgent([]);
    const deleteFile = jest.fn();
    await expect(
      upload(
        agent,
        'new-file',
        async () => {
          await methods.createFile(fileInfo('new-file'), true);
          throw new Error('lost acknowledgement');
        },
        deleteFile,
      ),
    ).rejects.toThrow('lost acknowledgement');

    expect(await linkedIds(agent)).toEqual(['new-file']);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('links the file and writes its record on success', async () => {
    const agent = await seedAgent([]);
    const deleteFile = jest.fn();
    await upload(
      agent,
      'new-file',
      () => methods.createFile(fileInfo('new-file'), true),
      deleteFile,
    );

    expect(await linkedIds(agent)).toEqual(['new-file']);
    expect(await File.countDocuments({ file_id: 'new-file' })).toBe(1);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
