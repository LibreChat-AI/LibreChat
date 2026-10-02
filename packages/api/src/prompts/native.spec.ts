import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { PromptDatabase, PromptGroupRecord, PromptRecord } from './types';
import { createNativePromptAdapter } from './native';

let mongo: MongoMemoryServer;
let db: PromptDatabase;
let group: PromptGroupRecord;
let production: PromptRecord;
let draft: PromptRecord;
const author = new Types.ObjectId().toString();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
});

beforeEach(async () => {
  const adapter = createNativePromptAdapter(db);
  const created = await adapter.createPromptGroup({
    prompt: { prompt: 'Production prompt', type: 'text' },
    group: { name: 'Native group' },
    author,
    authorName: 'Author',
  });
  production = created.prompt as PromptRecord;
  ({ prompt: draft } = (await adapter.savePrompt?.({
    groupId: production.groupId,
    prompt: { prompt: 'Draft prompt', type: 'chat' },
    author,
  })) as { prompt: PromptRecord });
  group = (await adapter.getPromptGroup(production.groupId)) as PromptGroupRecord;
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

describe('createNativePromptAdapter', () => {
  it('returns records with string IDs', () => {
    expect(group).toEqual(
      expect.objectContaining({
        _id: production.groupId,
        author,
        productionId: production._id,
        productionPrompt: expect.objectContaining({
          _id: production._id,
          groupId: production.groupId,
        }),
      }),
    );
    expect(typeof draft._id).toBe('string');
    expect(draft).toEqual(expect.objectContaining({ groupId: group._id, author, type: 'chat' }));
  });

  it('resolves Production from a loaded group without another read', async () => {
    const adapter = createNativePromptAdapter(db);
    const readGroup = jest.spyOn(db, 'getPromptGroup');
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(
      adapter.resolvePrompt({
        groupId: group._id,
        selection: { type: 'production' },
        loadedGroup: group,
      }),
    ).resolves.toEqual({
      groupId: group._id,
      promptId: production._id,
      prompt: 'Production prompt',
      type: 'text',
    });
    expect(readGroup).not.toHaveBeenCalled();
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('reads the group once to resolve Production when no group is loaded', async () => {
    const adapter = createNativePromptAdapter(db);
    const readGroup = jest.spyOn(db, 'getPromptGroup');
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(
      adapter.resolvePrompt({ groupId: group._id, selection: { type: 'production' } }),
    ).resolves.toMatchObject({ promptId: production._id });
    expect(readGroup).toHaveBeenCalledTimes(1);
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('reads the group when the loaded group is a different group', async () => {
    const adapter = createNativePromptAdapter(db);
    const readGroup = jest.spyOn(db, 'getPromptGroup');

    await expect(
      adapter.resolvePrompt({
        groupId: group._id,
        selection: { type: 'production' },
        loadedGroup: { ...group, _id: new Types.ObjectId().toString() },
      }),
    ).resolves.toMatchObject({ promptId: production._id });
    expect(readGroup).toHaveBeenCalledTimes(1);
  });

  it('resolves an exact revision from a loaded revision without another read', async () => {
    const adapter = createNativePromptAdapter(db);
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(
      adapter.resolvePrompt({
        groupId: group._id,
        selection: { type: 'exact', promptId: draft._id },
        loadedRevision: draft,
      }),
    ).resolves.toEqual({
      groupId: group._id,
      promptId: draft._id,
      prompt: 'Draft prompt',
      type: 'chat',
    });
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('reads an exact revision when the loaded revision is a different revision', async () => {
    const adapter = createNativePromptAdapter(db);
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(
      adapter.resolvePrompt({
        groupId: group._id,
        selection: { type: 'exact', promptId: draft._id },
        loadedRevision: production,
      }),
    ).resolves.toMatchObject({ promptId: draft._id });
    expect(readPrompt).toHaveBeenCalledTimes(1);
  });

  it('does not resolve a revision of another group or a missing selection', async () => {
    const adapter = createNativePromptAdapter(db);
    const otherGroupId = new Types.ObjectId().toString();

    await expect(
      adapter.resolvePrompt({
        groupId: otherGroupId,
        selection: { type: 'exact', promptId: draft._id },
      }),
    ).resolves.toBeNull();
    await expect(
      adapter.resolvePrompt({ groupId: otherGroupId, selection: { type: 'production' } }),
    ).resolves.toBeNull();
    await expect(
      adapter.resolvePrompt({
        groupId: group._id,
        selection: { type: 'exact', promptId: new Types.ObjectId().toString() },
      }),
    ).resolves.toBeNull();
  });

  it('resolves a stored revision without a type as text', async () => {
    const adapter = createNativePromptAdapter(db);
    await mongoose.models.Prompt.collection.updateMany(
      { groupId: new Types.ObjectId(group._id) },
      { $unset: { type: '' } },
    );
    const loaded = (await adapter.getPromptGroup(group._id)) as PromptGroupRecord;

    await expect(
      adapter.resolvePrompt({ groupId: group._id, selection: { type: 'production' } }),
    ).resolves.toMatchObject({ promptId: production._id, type: 'text' });
    await expect(
      adapter.resolvePrompt({
        groupId: group._id,
        selection: { type: 'production' },
        loadedGroup: loaded,
      }),
    ).resolves.toMatchObject({ promptId: production._id, type: 'text' });
    await expect(
      adapter.resolvePrompt({
        groupId: group._id,
        selection: { type: 'exact', promptId: draft._id },
      }),
    ).resolves.toMatchObject({ promptId: draft._id, type: 'text' });
  });

  it('returns null for absent records', async () => {
    const adapter = createNativePromptAdapter(db);
    const missing = new Types.ObjectId().toString();

    await expect(adapter.getPromptGroup(missing)).resolves.toBeNull();
    await expect(adapter.getPrompt(missing)).resolves.toBeNull();
  });

  it('returns the group revisions newest first', async () => {
    const adapter = createNativePromptAdapter(db);
    await mongoose.models.Prompt.collection.updateOne(
      { _id: new Types.ObjectId(draft._id) },
      { $set: { createdAt: new Date(Date.now() + 1000) } },
    );

    const revisions = await adapter.getPrompts(group._id);

    expect(revisions.map((revision) => revision._id)).toEqual([draft._id, production._id]);
  });

  it('promotes a revision and throws for a missing revision', async () => {
    const adapter = createNativePromptAdapter(db);

    await adapter.makePromptProduction?.(draft._id);

    await expect(adapter.getPromptGroup(group._id)).resolves.toMatchObject({
      productionId: draft._id,
    });
    await expect(adapter.makePromptProduction?.(new Types.ObjectId().toString())).rejects.toThrow(
      'Prompt not found',
    );
  });

  it('returns a string group ID when deleting the last revision deletes the group', async () => {
    const adapter = createNativePromptAdapter(db);

    await expect(
      adapter.deletePrompt?.({ groupId: group._id, promptId: draft._id }),
    ).resolves.toEqual({ prompt: 'Prompt deleted successfully' });
    await expect(
      adapter.deletePrompt?.({ groupId: group._id, promptId: production._id }),
    ).resolves.toEqual({
      prompt: 'Prompt deleted successfully',
      promptGroup: { message: 'Prompt group deleted successfully', id: group._id },
    });
  });
});
