import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IAssistant } from '~/types';
import { runAsSystem, tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import { createAssistantMethods } from './assistant';
import assistantSchema from '~/schema/assistant';

const schema = assistantSchema.clone();
applyTenantIsolation(schema);
const Assistant = mongoose.model<IAssistant>('Assistant', schema);
const methods = createAssistantMethods(mongoose);
const ownerId = new mongoose.Types.ObjectId();
const attackerId = new mongoose.Types.ObjectId();
const originalAvatar = { filepath: '/images/original.png', source: 'local' };
const avatar = { filepath: '/images/replacement.png', source: 'local' };
let mongoServer: MongoMemoryServer;

const updateAvatar = (query: Parameters<typeof methods.updateAssistantAvatar>[0]) =>
  tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
    methods.updateAssistantAvatar(query, avatar),
  );

const readAssistant = (assistantId = 'victim-assistant') =>
  runAsSystem(async () => Assistant.findOne({ assistant_id: assistantId }).lean<IAssistant>());

const referenceId = (tenantId: string | null, assistantId: string) =>
  new mongoose.Types.ObjectId(
    createHash('sha256')
      .update(JSON.stringify([tenantId, assistantId]))
      .digest('hex')
      .slice(0, 24),
  );

function synchronizeAbsentReads(assistantId: string, count: number) {
  const findOne = Assistant.collection.findOne.bind(Assistant.collection);
  let release!: () => void;
  const allRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  return jest.spyOn(Assistant.collection, 'findOne').mockImplementation(async (...args) => {
    const result = await findOne(...args);
    if (args[0].assistant_id === assistantId && !result) {
      if (++arrived === count) {
        release();
      }
      await allRead;
    }
    return result;
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongoServer.getUri());
  await Assistant.init();
});

beforeEach(async () => {
  await runAsSystem(async () => {
    await Assistant.deleteMany({});
    await Assistant.create([
      {
        assistant_id: 'victim-assistant',
        user: ownerId,
        endpoint: 'openAI',
        avatar: originalAvatar,
        tenantId: 'tenant-a',
      },
      {
        assistant_id: 'attacker-assistant',
        user: attackerId,
        endpoint: 'azureOpenAI',
        avatar: originalAvatar,
        tenantId: 'tenant-a',
      },
    ]);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  mongoose.deleteModel('Assistant');
  await mongoServer?.stop();
});

describe('updateAssistantAvatar', () => {
  it("cannot update another user's assistant or claim its ownership", async () => {
    const result = await updateAvatar({
      assistantId: 'victim-assistant',
      user: attackerId.toString(),
    });

    expect(result).toBeNull();
    expect(await readAssistant()).toMatchObject({
      user: ownerId,
      endpoint: 'openAI',
      avatar: originalAvatar,
    });
    expect(await readAssistant('attacker-assistant')).toMatchObject({
      user: attackerId,
      endpoint: 'azureOpenAI',
      avatar: originalAvatar,
    });
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it("updates the correct owner's avatar without changing ownership or endpoint", async () => {
    const original = await readAssistant();
    const result = await updateAvatar({
      assistantId: 'victim-assistant',
      user: ownerId.toString(),
    });

    expect(result).toMatchObject({
      assistant_id: 'victim-assistant',
      user: ownerId,
      endpoint: 'openAI',
      avatar,
    });
    expect(result?._id).toEqual(original?._id);
    expect(result?.previousAvatar).toEqual(originalAvatar);
    const stored = await readAssistant();
    expect(stored).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
    expect(stored).not.toHaveProperty('previousAvatar');
    expect(await readAssistant('attacker-assistant')).toMatchObject({ avatar: originalAvatar });
  });

  it('allows a manager selector without user while preserving the original owner and endpoint', async () => {
    const result = await updateAvatar({ assistantId: 'victim-assistant' });

    expect(result).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
    expect(await readAssistant()).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
  });

  it('returns null for an unknown assistant without inserting a document', async () => {
    const result = await updateAvatar({
      assistantId: 'missing-assistant',
      user: ownerId.toString(),
    });

    expect(result).toBeNull();
    expect(await readAssistant('missing-assistant')).toBeNull();
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it('creates an authorized shared reference in the active tenant', async () => {
    const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      methods.updateAssistantAvatar({ assistantId: 'provider-only' }, avatar, {
        user: attackerId.toString(),
        endpoint: 'assistants',
      }),
    );

    expect(result).toMatchObject({
      assistant_id: 'provider-only',
      user: attackerId,
      endpoint: 'assistants',
      tenantId: 'tenant-a',
      avatar,
    });
    expect(result).not.toHaveProperty('previousAvatar');
    expect(await readAssistant('provider-only')).toMatchObject({ avatar });
  });

  it('converges concurrent initializations across method factories within the active tenant', async () => {
    const assistantId = 'concurrent-provider-only';
    const count = 16;
    synchronizeAbsentReads(assistantId, count);
    const insert = jest.spyOn(Assistant.collection, 'insertOne');
    const results = await Promise.all(
      Array.from({ length: count }, () => {
        const factory = createAssistantMethods(mongoose);
        return tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          factory.updateAssistantAvatar({ assistantId, user: ownerId.toString() }, avatar, {
            user: ownerId.toString(),
            endpoint: 'assistants',
          }),
        );
      }),
    );

    expect(insert).toHaveBeenCalledTimes(count);
    for (const result of results) {
      expect(result).toMatchObject({
        _id: referenceId('tenant-a', assistantId),
        assistant_id: assistantId,
        user: ownerId,
        endpoint: 'assistants',
        tenantId: 'tenant-a',
        avatar,
      });
      expect(result).not.toHaveProperty('previousAvatar');
    }
    expect(
      await runAsSystem(async () => Assistant.countDocuments({ assistant_id: assistantId })),
    ).toBe(1);

    const foreign = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      createAssistantMethods(mongoose).updateAssistantAvatar(
        { assistantId, user: attackerId.toString() },
        originalAvatar,
        { user: attackerId.toString(), endpoint: 'azureAssistants' },
      ),
    );
    expect(foreign).toMatchObject({
      _id: referenceId('tenant-b', assistantId),
      assistant_id: assistantId,
      user: attackerId,
      endpoint: 'azureAssistants',
      tenantId: 'tenant-b',
      avatar: originalAvatar,
    });
    expect(
      await runAsSystem(async () => Assistant.countDocuments({ assistant_id: assistantId })),
    ).toBe(2);
    expect(
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        Assistant.findOne({ assistant_id: assistantId }).lean<IAssistant>(),
      ),
    ).toMatchObject({ user: ownerId, endpoint: 'assistants', avatar, tenantId: 'tenant-a' });
  });

  it('normalizes absent, empty and system tenant contexts for concurrent initialization', async () => {
    const assistantId = 'tenantless-provider-only';
    const contexts = [undefined, '', SYSTEM_TENANT_ID];
    const count = 15;
    synchronizeAbsentReads(assistantId, count);
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) => {
        const factory = createAssistantMethods(mongoose);
        return tenantStorage.run({ tenantId: contexts[index % contexts.length] }, async () =>
          factory.updateAssistantAvatar({ assistantId }, avatar, {
            user: ownerId.toString(),
            endpoint: 'assistants',
          }),
        );
      }),
    );
    for (const result of results) {
      expect(result).toMatchObject({
        _id: referenceId(null, assistantId),
        user: ownerId,
        endpoint: 'assistants',
        avatar,
      });
      expect(result?.tenantId).toBeUndefined();
    }
    expect(
      await runAsSystem(async () => Assistant.countDocuments({ assistant_id: assistantId })),
    ).toBe(1);
  });

  it('does not let concurrent owner-scoped initializations take over the winning reference', async () => {
    const assistantId = 'contested-provider-only';
    const count = 16;
    const identities = [
      { user: ownerId.toString(), endpoint: 'assistants', avatar: originalAvatar },
      { user: attackerId.toString(), endpoint: 'azureAssistants', avatar },
    ];
    synchronizeAbsentReads(assistantId, count);
    const results = await Promise.allSettled(
      Array.from({ length: count }, (_, index) => {
        const factory = createAssistantMethods(mongoose);
        const identity = identities[index % identities.length];
        return tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          factory.updateAssistantAvatar({ assistantId, user: identity.user }, identity.avatar, {
            user: identity.user,
            endpoint: identity.endpoint,
          }),
        );
      }),
    );
    const reference = await readAssistant(assistantId);
    const winner = identities.find((identity) => identity.user === reference?.user.toString());
    expect(winner).toBeDefined();
    expect(reference).toMatchObject({
      _id: referenceId('tenant-a', assistantId),
      user: new mongoose.Types.ObjectId(winner?.user),
      endpoint: winner?.endpoint,
      avatar: winner?.avatar,
      tenantId: 'tenant-a',
    });
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(count / 2);
    for (const [index, result] of results.entries()) {
      if (identities[index % identities.length].user === winner?.user) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value?._id).toEqual(reference?._id);
        }
      } else {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({
            message: 'Assistant ownership changed before the avatar update',
          });
        }
      }
    }
    expect(
      await runAsSystem(async () => Assistant.countDocuments({ assistant_id: assistantId })),
    ).toBe(1);
  });

  it.each(['assistant', 'tenant'] as const)(
    'does not recover an unrelated %s from a deterministic id collision',
    async (mismatch) => {
      const assistantId = 'colliding-provider-only';
      const _id = referenceId('tenant-a', assistantId);
      await runAsSystem(async () =>
        Assistant.create({
          _id,
          assistant_id: mismatch === 'assistant' ? 'unrelated-assistant' : assistantId,
          user: attackerId,
          endpoint: 'azureAssistants',
          tenantId: mismatch === 'tenant' ? 'tenant-b' : 'tenant-a',
          avatar: originalAvatar,
        }),
      );
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          methods.updateAssistantAvatar({ assistantId, user: ownerId.toString() }, avatar, {
            user: ownerId.toString(),
            endpoint: 'assistants',
          }),
        ),
      ).rejects.toMatchObject({ code: 11000 });
      expect(
        await runAsSystem(async () => Assistant.findById(_id).lean<IAssistant>()),
      ).toMatchObject({
        user: attackerId,
        endpoint: 'azureAssistants',
        avatar: originalAvatar,
      });
      expect(await runAsSystem(async () => Assistant.countDocuments({ _id }))).toBe(1);
    },
  );

  it('never applies insert-only identity to an existing shared assistant', async () => {
    const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      methods.updateAssistantAvatar({ assistantId: 'victim-assistant' }, avatar, {
        user: attackerId.toString(),
        endpoint: 'assistants',
      }),
    );

    expect(result).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
    expect(await readAssistant()).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it('creates a provider-authorized owner-scoped reference when none exists', async () => {
    const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      methods.updateAssistantAvatar(
        { assistantId: 'provider-only', user: ownerId.toString() },
        avatar,
        { user: ownerId.toString(), endpoint: 'assistants' },
      ),
    );

    expect(result).toMatchObject({
      assistant_id: 'provider-only',
      user: ownerId,
      endpoint: 'assistants',
      tenantId: 'tenant-a',
      avatar,
    });
  });

  it('cannot duplicate or take over an existing assistant through owner-scoped insertion', async () => {
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.updateAssistantAvatar(
          { assistantId: 'victim-assistant', user: attackerId.toString() },
          avatar,
          { user: attackerId.toString(), endpoint: 'assistants' },
        ),
      ),
    ).rejects.toThrow('Assistant ownership changed');

    expect(await readAssistant()).toMatchObject({
      user: ownerId,
      endpoint: 'openAI',
      avatar: originalAvatar,
    });
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it('inserts a tenant-local reference without modifying an overlapping foreign assistant', async () => {
    const result = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      methods.updateAssistantAvatar({ assistantId: 'victim-assistant' }, avatar, {
        user: attackerId.toString(),
        endpoint: 'assistants',
      }),
    );

    expect(result).toMatchObject({ user: attackerId, tenantId: 'tenant-b', avatar });
    const original = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      Assistant.findOne({ assistant_id: 'victim-assistant' }).lean<IAssistant>(),
    );
    expect(original).toMatchObject({ user: ownerId, avatar: originalAvatar });
  });

  it.each([undefined, null, ''])(
    'backfills a missing endpoint (%p) without changing its owner',
    async (endpoint) => {
      await Assistant.updateOne(
        { assistant_id: 'victim-assistant' },
        endpoint === undefined ? { $unset: { endpoint: 1 } } : { $set: { endpoint } },
      );
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.updateAssistantAvatar({ assistantId: 'victim-assistant' }, avatar, {
          user: attackerId.toString(),
          endpoint: 'assistants',
        }),
      );
      expect(result).toMatchObject({ user: ownerId, endpoint: 'assistants', avatar });
    },
  );

  it.each([false, true])(
    'initializes an ownerless reference with null owner=%p',
    async (nullOwner) => {
      await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.updateAssistantDoc(
          { assistantId: 'ownerless' },
          {
            conversation_starters: ['Hello'],
            append_current_datetime: true,
            avatar: originalAvatar,
          },
        ),
      );
      if (nullOwner) {
        await Assistant.updateOne({ assistant_id: 'ownerless' }, { $set: { user: null } });
      }
      const mutate = jest.spyOn(Assistant, 'findOneAndUpdate');
      const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.updateAssistantAvatar(
          { assistantId: 'ownerless', user: ownerId.toString() },
          avatar,
          { user: ownerId.toString(), endpoint: 'assistants' },
        ),
      );
      expect(result).toMatchObject({
        user: ownerId,
        endpoint: 'assistants',
        avatar,
        conversation_starters: ['Hello'],
        append_current_datetime: true,
      });
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: result?._id,
          assistant_id: 'ownerless',
          user: null,
          endpoint: null,
          avatar: originalAvatar,
        }),
        { $set: { avatar, user: ownerId.toString(), endpoint: 'assistants' } },
        { new: true },
      );
      expect(
        await runAsSystem(async () => Assistant.countDocuments({ assistant_id: 'ownerless' })),
      ).toBe(1);
    },
  );

  it('keeps an ownerless reference unchanged for an owner-scoped request without insert identity', async () => {
    await Assistant.updateOne({ assistant_id: 'victim-assistant' }, { $unset: { user: 1 } });
    const mutate = jest.spyOn(Assistant, 'findOneAndUpdate');
    expect(
      await updateAvatar({ assistantId: 'victim-assistant', user: ownerId.toString() }),
    ).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    const reference = await readAssistant();
    expect(reference?.user).toBeUndefined();
    expect(reference).toMatchObject({ endpoint: 'openAI', avatar: originalAvatar });
  });

  it('updates an incomplete shared reference without claiming identity when insert data is omitted', async () => {
    await Assistant.updateOne(
      { assistant_id: 'victim-assistant' },
      { $unset: { user: 1, endpoint: 1 } },
    );
    const result = await updateAvatar({ assistantId: 'victim-assistant' });
    expect(result).toMatchObject({ avatar, previousAvatar: originalAvatar });
    expect(result?.user).toBeUndefined();
    expect(result?.endpoint).toBeUndefined();
    expect(await readAssistant()).toMatchObject({ avatar });
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it.each([undefined, null])(
    'updates a missing avatar (%p) without a previous file',
    async (value) => {
      await Assistant.updateOne(
        { assistant_id: 'victim-assistant' },
        value === undefined ? { $unset: { avatar: 1 } } : { $set: { avatar: value } },
      );
      const result = await updateAvatar({ assistantId: 'victim-assistant' });
      expect(result).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
      expect(result?.previousAvatar).toBe(value);
      expect(await readAssistant()).not.toHaveProperty('previousAvatar');
    },
  );

  it('does not return a cleanup receipt when the requested avatar already matches', async () => {
    await updateAvatar({ assistantId: 'victim-assistant' });
    const mutate = jest.spyOn(Assistant, 'findOneAndUpdate');
    const result = await updateAvatar({ assistantId: 'victim-assistant' });
    expect(result).toMatchObject({ avatar });
    expect(result).not.toHaveProperty('previousAvatar');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('uses one guarded write for a complete existing reference', async () => {
    const mutate = jest.spyOn(Assistant, 'findOneAndUpdate');
    const result = await tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
      methods.updateAssistantAvatar(
        { assistantId: 'victim-assistant', user: ownerId.toString() },
        avatar,
        { user: ownerId.toString(), endpoint: 'assistants' },
      ),
    );
    expect(result).toMatchObject({ user: ownerId, endpoint: 'openAI', avatar });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { field: 'user', missingUser: false },
    { field: 'endpoint', missingUser: false },
    { field: 'user', missingUser: true },
    { field: 'endpoint', missingUser: true },
  ])(
    'rejects a concurrent $field assignment without changing the avatar (missing user: $missingUser)',
    async ({ field, missingUser }) => {
      await Assistant.updateOne(
        { assistant_id: 'victim-assistant' },
        { $unset: { endpoint: 1, ...(missingUser ? { user: 1 } : {}) } },
      );
      const original = Assistant.collection.findOne.bind(Assistant.collection);
      let raced = false;
      jest.spyOn(Assistant.collection, 'findOne').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (!raced && result) {
          raced = true;
          await Assistant.updateOne(
            { assistant_id: 'victim-assistant' },
            {
              $set: field === 'user' ? { user: attackerId } : { endpoint: 'azureAssistants' },
            },
          );
        }
        return result;
      });
      await expect(
        tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
          methods.updateAssistantAvatar(
            { assistantId: 'victim-assistant', user: ownerId.toString() },
            avatar,
            { user: ownerId.toString(), endpoint: 'assistants' },
          ),
        ),
      ).rejects.toThrow('Assistant identity changed');
      const doc = await readAssistant();
      expect(raced).toBe(true);
      expect(doc).toMatchObject({
        ...(field === 'user' ? { user: attackerId } : { endpoint: 'azureAssistants' }),
        avatar: originalAvatar,
      });
      expect(
        await runAsSystem(async () =>
          Assistant.countDocuments({ assistant_id: 'victim-assistant' }),
        ),
      ).toBe(1);
    },
  );

  it('rejects a stale avatar snapshot without overwriting the concurrent avatar', async () => {
    const concurrentAvatar = { filepath: '/images/concurrent.png', source: 'local' };
    const findOne = Assistant.collection.findOne.bind(Assistant.collection);
    let raced = false;
    jest.spyOn(Assistant.collection, 'findOne').mockImplementation(async (...args) => {
      const result = await findOne(...args);
      if (!raced && result) {
        raced = true;
        await Assistant.updateOne(
          { assistant_id: 'victim-assistant' },
          { $set: { avatar: concurrentAvatar } },
        );
      }
      return result;
    });
    await expect(updateAvatar({ assistantId: 'victim-assistant' })).rejects.toThrow(
      'Assistant identity changed',
    );
    expect(raced).toBe(true);
    expect(await readAssistant()).toMatchObject({
      user: ownerId,
      endpoint: 'openAI',
      avatar: concurrentAvatar,
    });
    expect(
      await runAsSystem(async () => Assistant.countDocuments({ assistant_id: 'victim-assistant' })),
    ).toBe(1);
  });

  it('propagates unexpected reference read failures without writing an avatar', async () => {
    const failure = new Error('reference read failed');
    jest.spyOn(Assistant.collection, 'findOne').mockRejectedValueOnce(failure);
    const mutate = jest.spyOn(Assistant, 'findOneAndUpdate');
    const create = jest.spyOn(Assistant, 'create');
    await expect(updateAvatar({ assistantId: 'victim-assistant' })).rejects.toBe(failure);
    expect(mutate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await readAssistant()).toMatchObject({ avatar: originalAvatar });
  });

  it('propagates unexpected creation failures without reloading or inserting a reference', async () => {
    const failure = new Error('reference insert failed');
    jest.spyOn(Assistant.collection, 'insertOne').mockRejectedValueOnce(failure);
    const read = jest.spyOn(Assistant, 'findOne');
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.updateAssistantAvatar({ assistantId: 'provider-only' }, avatar, {
          user: ownerId.toString(),
          endpoint: 'assistants',
        }),
      ),
    ).rejects.toBe(failure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await readAssistant('provider-only')).toBeNull();
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it('propagates duplicate-key reload failures without inserting another reference', async () => {
    const duplicate = Object.assign(new Error('reference already exists'), { code: 11000 });
    const failure = new Error('reference reload failed');
    jest.spyOn(Assistant.collection, 'insertOne').mockRejectedValueOnce(duplicate);
    const findOne = Assistant.collection.findOne.bind(Assistant.collection);
    jest
      .spyOn(Assistant.collection, 'findOne')
      .mockImplementationOnce((...args) => findOne(...args))
      .mockRejectedValueOnce(failure);
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.updateAssistantAvatar({ assistantId: 'provider-only' }, avatar, {
          user: ownerId.toString(),
          endpoint: 'assistants',
        }),
      ),
    ).rejects.toBe(failure);
    expect(await readAssistant('provider-only')).toBeNull();
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it('propagates guarded update failures without an early avatar write', async () => {
    await Assistant.updateOne({ assistant_id: 'victim-assistant' }, { $unset: { endpoint: 1 } });
    const failure = new Error('reference update failed');
    jest.spyOn(Assistant.collection, 'findOneAndUpdate').mockRejectedValueOnce(failure);
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, async () =>
        methods.updateAssistantAvatar({ assistantId: 'victim-assistant' }, avatar, {
          user: ownerId.toString(),
          endpoint: 'assistants',
        }),
      ),
    ).rejects.toBe(failure);
    const reference = await readAssistant();
    expect(reference).toMatchObject({ user: ownerId, avatar: originalAvatar });
    expect(reference?.endpoint).toBeUndefined();
    expect(await runAsSystem(async () => Assistant.countDocuments())).toBe(2);
  });

  it.each<{ onInsert: unknown }>([
    { onInsert: null },
    { onInsert: {} },
    { onInsert: { user: '', endpoint: 'assistants' } },
    { onInsert: { user: attackerId.toString(), endpoint: '' } },
    { onInsert: { user: { $ne: null }, endpoint: 'assistants' } },
    { onInsert: { user: attackerId.toString(), endpoint: ['assistants'] } },
  ])('rejects invalid insert identity before querying: $onInsert', async ({ onInsert }) => {
    const findOne = jest.spyOn(Assistant, 'findOne');
    const findOneAndUpdate = jest.spyOn(Assistant, 'findOneAndUpdate');
    await expect(
      // @ts-expect-error JavaScript callers can supply invalid insertion data at runtime.
      methods.updateAssistantAvatar({ assistantId: 'provider-only' }, avatar, onInsert),
    ).rejects.toThrow('Avatar insert data must identify');
    expect(findOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('requires insert identity to agree with the authorized owner scope', async () => {
    const findOne = jest.spyOn(Assistant, 'findOne');
    const findOneAndUpdate = jest.spyOn(Assistant, 'findOneAndUpdate');
    await expect(
      methods.updateAssistantAvatar(
        { assistantId: 'provider-only', user: ownerId.toString() },
        avatar,
        { user: attackerId.toString(), endpoint: 'assistants' },
      ),
    ).rejects.toThrow('Avatar insert data must identify');
    expect(findOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each<{ query: unknown }>([
    { query: undefined },
    { query: null },
    { query: {} },
    { query: { assistantId: undefined } },
    { query: { assistantId: null } },
    { query: { assistantId: '' } },
    { query: { assistantId: ' \t\n ' } },
    { query: { assistantId: false } },
    { query: { assistantId: 42 } },
    { query: { assistantId: [] } },
    { query: { assistantId: ['victim-assistant'] } },
    { query: { assistantId: { $ne: null } } },
    { query: Object.setPrototypeOf({}, { assistantId: 'victim-assistant' }) },
  ])('rejects invalid assistant selectors before querying: $query', async ({ query }) => {
    const findOne = jest.spyOn(Assistant, 'findOne');
    const findOneAndUpdate = jest.spyOn(Assistant, 'findOneAndUpdate');

    // @ts-expect-error JavaScript callers can supply invalid selectors at runtime.
    await expect(updateAvatar(query)).rejects.toThrow('assistantId must be a nonempty string');

    expect(findOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(await readAssistant()).toMatchObject({ avatar: originalAvatar });
  });

  it.each([
    { user: null },
    { user: '' },
    { user: ' \t\n ' },
    { user: false },
    { user: 42 },
    { user: [] },
    { user: [ownerId.toString()] },
    { user: { $ne: null } },
  ])('rejects invalid owner selectors before querying: $user', async ({ user }) => {
    const findOne = jest.spyOn(Assistant, 'findOne');
    const findOneAndUpdate = jest.spyOn(Assistant, 'findOneAndUpdate');

    // @ts-expect-error JavaScript callers can supply invalid owner selectors at runtime.
    await expect(updateAvatar({ assistantId: 'victim-assistant', user })).rejects.toThrow(
      'user must be a nonempty string',
    );

    expect(findOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(await readAssistant()).toMatchObject({ user: ownerId, avatar: originalAvatar });
  });

  it('rejects inherited owner selectors before querying', async () => {
    const findOne = jest.spyOn(Assistant, 'findOne');
    const findOneAndUpdate = jest.spyOn(Assistant, 'findOneAndUpdate');
    const query = Object.setPrototypeOf(
      { assistantId: 'victim-assistant' },
      { user: attackerId.toString() },
    );

    await expect(updateAvatar(query)).rejects.toThrow('user must be a nonempty string');

    expect(findOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(await readAssistant()).toMatchObject({ user: ownerId, avatar: originalAvatar });
  });

  it("cannot update another tenant's assistant when user is omitted", async () => {
    await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      Assistant.create({
        assistant_id: 'foreign-assistant',
        user: ownerId,
        endpoint: 'azureOpenAI',
        avatar: originalAvatar,
      }),
    );

    expect(await updateAvatar({ assistantId: 'foreign-assistant' })).toBeNull();
    expect(await readAssistant('foreign-assistant')).toMatchObject({
      user: ownerId,
      endpoint: 'azureOpenAI',
      avatar: originalAvatar,
      tenantId: 'tenant-b',
    });
  });

  it('updates only the active tenant when assistant identifiers overlap', async () => {
    await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      Assistant.create({
        assistant_id: 'victim-assistant',
        user: attackerId,
        endpoint: 'azureOpenAI',
        avatar: originalAvatar,
      }),
    );

    expect(await updateAvatar({ assistantId: 'victim-assistant' })).toMatchObject({
      user: ownerId,
      endpoint: 'openAI',
      avatar,
      tenantId: 'tenant-a',
    });
    const foreignAssistant = await tenantStorage.run({ tenantId: 'tenant-b' }, async () =>
      Assistant.findOne({ assistant_id: 'victim-assistant' }).lean<IAssistant>(),
    );
    expect(foreignAssistant).toMatchObject({
      user: attackerId,
      endpoint: 'azureOpenAI',
      avatar: originalAvatar,
      tenantId: 'tenant-b',
    });
  });
});
