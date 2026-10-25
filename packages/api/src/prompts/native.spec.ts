import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { PromptDatabase, PromptGroupRecord, PromptRecord } from './types';
import { createNativePromptAdapter } from './native';
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

describe('createNativePromptAdapter', () => {
  it('resolves Production from the group inlined revision without reading it again', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(
      adapter.resolvePrompt({ group, selection: { type: 'production' } }),
    ).resolves.toEqual({
      ok: true,
      value: {
        source: 'native',
        groupId: group._id,
        promptId: production._id,
        prompt: 'Production prompt',
        type: 'text',
      },
    });
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('reads the Production revision when the group has no inlined revision', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));
    const readPrompt = jest.spyOn(db, 'getPrompt');
    const { productionPrompt: _productionPrompt, ...groupWithoutInlinedRevision } = group;

    await expect(
      adapter.resolvePrompt({
        group: groupWithoutInlinedRevision,
        selection: { type: 'production' },
      }),
    ).resolves.toMatchObject({ ok: true, value: { promptId: production._id } });
    expect(readPrompt).toHaveBeenCalledTimes(1);
  });

  it('resolves an exact revision from a loaded revision without another read', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(
      adapter.resolvePrompt({
        group,
        selection: { type: 'exact', promptId: draft._id },
        loadedRevision: draft,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        source: 'native',
        groupId: group._id,
        promptId: draft._id,
        prompt: 'Draft prompt',
        type: 'chat',
      },
    });
    expect(readPrompt).not.toHaveBeenCalled();
  });

  it('reads an exact revision when the loaded revision is a different revision', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));
    const readPrompt = jest.spyOn(db, 'getPrompt');

    await expect(
      adapter.resolvePrompt({
        group,
        selection: { type: 'exact', promptId: draft._id },
        loadedRevision: production,
      }),
    ).resolves.toMatchObject({ ok: true, value: { promptId: draft._id } });
    expect(readPrompt).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable_selection for a missing revision or group with no Production', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));

    await expect(
      adapter.resolvePrompt({
        group,
        selection: { type: 'exact', promptId: new Types.ObjectId().toString() },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unavailable_selection', reason: 'revision' },
    });
    await expect(
      adapter.resolvePrompt({
        group: { ...group, productionId: null, productionPrompt: null },
        selection: { type: 'production' },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unavailable_selection', reason: 'production' },
    });
  });

  it('does not resolve a revision belonging to another group', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));
    const otherGroup = { ...group, _id: new Types.ObjectId().toString() };

    await expect(
      adapter.resolvePrompt({
        group: otherGroup,
        selection: { type: 'exact', promptId: draft._id },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unavailable_selection', reason: 'revision' },
    });
    await expect(
      adapter.resolvePrompt({ group: otherGroup, selection: { type: 'production' } }),
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unavailable_selection', reason: 'production' },
    });
  });

  it('returns unsupported_selection for a version selection', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));

    await expect(
      adapter.resolvePrompt({ group, selection: { type: 'version', version: 1 } }),
    ).resolves.toEqual({
      ok: false,
      error: { type: 'unsupported_selection', source: 'native' },
    });
  });

  it('resolves a stored revision without a type as text', async () => {
    const adapter = createNativePromptAdapter(createPromptStore(db));
    await mongoose.models.Prompt.collection.updateMany(
      { groupId: new Types.ObjectId(group._id) },
      { $unset: { type: '' } },
    );
    const loaded = (await createPromptStore(db).getPromptGroup(group._id)) as PromptGroupRecord;

    await expect(
      adapter.resolvePrompt({ group: loaded, selection: { type: 'production' } }),
    ).resolves.toMatchObject({ ok: true, value: { promptId: production._id, type: 'text' } });
    await expect(
      adapter.resolvePrompt({
        group: loaded,
        selection: { type: 'exact', promptId: draft._id },
      }),
    ).resolves.toMatchObject({ ok: true, value: { promptId: draft._id, type: 'text' } });
  });
});
