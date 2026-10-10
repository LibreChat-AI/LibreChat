import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { PromptDatabase, PromptRecord } from './types';
import { createPromptAccessResolvers } from './access';
import { createNativePromptAdapter } from './native';

let mongo: MongoMemoryServer;
let db: PromptDatabase;
let revision: PromptRecord;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});

beforeEach(async () => {
  const created = await createNativePromptAdapter(db).createPromptGroup({
    prompt: { prompt: 'Prompt', type: 'text' },
    group: { name: 'Access group' },
    author: new Types.ObjectId().toString(),
    authorName: 'Author',
  });
  revision = created.prompt as PromptRecord;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.models.Prompt.deleteMany({});
  await mongoose.models.PromptGroup.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('createPromptAccessResolvers', () => {
  it('resolves a group and a revision with string IDs', async () => {
    const resolvers = createPromptAccessResolvers(db);

    await expect(resolvers.resolvePromptGroup(revision.groupId)).resolves.toMatchObject({
      _id: revision.groupId,
      productionId: revision._id,
    });
    await expect(resolvers.resolvePromptViaGroup(revision._id)).resolves.toEqual({
      _id: revision.groupId,
      prompt: expect.objectContaining({ _id: revision._id, groupId: revision.groupId }),
    });
  });

  it('returns null for a missing record', async () => {
    const resolvers = createPromptAccessResolvers(db);
    const missing = new Types.ObjectId().toString();

    await expect(resolvers.resolvePromptGroup(missing)).resolves.toBeNull();
    await expect(resolvers.resolvePromptViaGroup(missing)).resolves.toBeNull();
  });

  it('returns null for a malformed ID without a read', async () => {
    const resolvers = createPromptAccessResolvers(db);
    const readGroup = jest.spyOn(db, 'getPromptGroup');
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(resolvers.resolvePromptGroup('test-404')).resolves.toBeNull();
    await expect(resolvers.resolvePromptViaGroup('test-404')).resolves.toBeNull();
    expect(readGroup).not.toHaveBeenCalled();
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('propagates a read failure', async () => {
    const resolvers = createPromptAccessResolvers(db);
    const failure = new Error('database unavailable');
    jest.spyOn(db, 'getPromptGroup').mockRejectedValueOnce(failure);
    jest.spyOn(db, 'getPrompt').mockRejectedValueOnce(failure);

    await expect(resolvers.resolvePromptGroup(revision.groupId)).rejects.toBe(failure);
    await expect(resolvers.resolvePromptViaGroup(revision._id)).rejects.toBe(failure);
  });
});
