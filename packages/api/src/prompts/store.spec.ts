import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { PromptDatabase, PromptGroupRecord, PromptRecord } from './types';
import { createPromptStore } from './store';

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
  await mongoose.models.PromptGroup.syncIndexes();
});

beforeEach(async () => {
  const store = createPromptStore(db);
  const created = await store.createPromptGroup({
    prompt: { prompt: 'Production prompt', type: 'text' },
    group: { name: 'Native group' },
    author,
    authorName: 'Author',
  });
  production = created.prompt as PromptRecord;
  ({ prompt: draft } = await store.savePrompt({
    groupId: production.groupId,
    prompt: { prompt: 'Draft prompt', type: 'chat' },
    author,
  }));
  group = (await store.getPromptGroup(production.groupId)) as PromptGroupRecord;
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

describe('createPromptStore', () => {
  it('returns records with string IDs', () => {
    expect(group).toEqual(
      expect.objectContaining({
        _id: production.groupId,
        author,
        source: 'native',
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

  it('returns null for an absent revision', async () => {
    const store = createPromptStore(db);
    const missing = new Types.ObjectId().toString();

    await expect(store.getPrompt(missing)).resolves.toBeNull();
  });

  it('returns the group revisions newest first', async () => {
    const store = createPromptStore(db);
    await mongoose.models.Prompt.collection.updateOne(
      { _id: new Types.ObjectId(draft._id) },
      { $set: { createdAt: new Date(Date.now() + 1000) } },
    );

    const revisions = await store.getPrompts(group._id);

    expect(revisions.map((revision) => revision._id)).toEqual([draft._id, production._id]);
  });

  it('promotes a revision and throws for a missing revision', async () => {
    const store = createPromptStore(db);

    await store.makePromptProduction(draft._id);

    await expect(store.getPromptGroup(group._id)).resolves.toMatchObject({
      productionId: draft._id,
    });
    await expect(store.makePromptProduction(new Types.ObjectId().toString())).rejects.toThrow(
      'Prompt not found',
    );
  });

  it('returns a string group ID when deleting the last revision deletes the group', async () => {
    const store = createPromptStore(db);

    await expect(store.deletePrompt({ groupId: group._id, promptId: draft._id })).resolves.toEqual({
      prompt: 'Prompt deleted successfully',
    });
    await expect(
      store.deletePrompt({ groupId: group._id, promptId: production._id }),
    ).resolves.toEqual({
      prompt: 'Prompt deleted successfully',
      promptGroup: { message: 'Prompt group deleted successfully', id: group._id },
    });
  });

  it('returns a group with string IDs through getPromptGroup', async () => {
    const store = createPromptStore(db);

    await expect(store.getPromptGroup(production.groupId)).resolves.toEqual(group);
  });

  it('returns null for a missing group', async () => {
    const store = createPromptStore(db);

    await expect(store.getPromptGroup(new Types.ObjectId().toString())).resolves.toBeNull();
  });

  describe('findSourceGroup and createSourceGroup', () => {
    const identity = {
      sourceDestination: 'us',
      sourceProjectId: 'project-1',
      sourcePromptName: 'synced-prompt',
    };

    it('returns null for an identity with no stored group', async () => {
      const store = createPromptStore(db);

      await expect(store.findSourceGroup(identity)).resolves.toBeNull();
    });

    it('creates a source group and then finds it by identity', async () => {
      const store = createPromptStore(db);

      const created = await store.createSourceGroup({
        identity,
        name: 'Synced prompt',
        author,
        authorName: 'Langfuse Sync',
      });

      expect(created).toEqual({ ok: true, value: { _id: expect.any(String) } });
      await expect(store.findSourceGroup(identity)).resolves.toEqual({
        _id: created.ok ? created.value._id : undefined,
      });
    });

    it('returns a duplicate error for a second insert with the same identity', async () => {
      const store = createPromptStore(db);
      await store.createSourceGroup({
        identity,
        name: 'Synced prompt',
        author,
        authorName: 'Langfuse Sync',
      });

      const result = await store.createSourceGroup({
        identity,
        name: 'Synced prompt again',
        author,
        authorName: 'Langfuse Sync',
      });

      expect(result).toEqual({ ok: false, error: { code: 'duplicate' } });
    });

    it('returns an invalid error with a cause for an empty name', async () => {
      const store = createPromptStore(db);

      const result = await store.createSourceGroup({
        identity,
        name: '',
        author,
        authorName: 'Langfuse Sync',
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid', cause: expect.any(Error) },
      });
    });

    it('rethrows a non-Mongo, non-validation error', async () => {
      const store = createPromptStore(db);
      jest.spyOn(db, 'createLangfusePromptGroup').mockRejectedValueOnce(new Error('unavailable'));

      await expect(
        store.createSourceGroup({
          identity,
          name: 'Synced prompt',
          author,
          authorName: 'Langfuse Sync',
        }),
      ).rejects.toThrow('unavailable');
    });
  });
});
