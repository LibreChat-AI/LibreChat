import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import type { AgentChannelRecord } from './channel';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { createUserMethods } from './user';
import { createModels } from '~/models';

let mongo: MongoMemoryReplSet;
let methods: ReturnType<typeof createAgentChannelMethods>;
let runs: ReturnType<typeof createChannelRunStorage>;
const tenantId = 'channel-metadata-test';
const scope = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
const channel = (): AgentChannelRecord => ({
  channelId: 'channel',
  tenantId,
  agentId: 'agent',
  createdBy: 'owner',
  type: 'slack',
  status: 'active',
  credentialMode: 'shared',
  revision: 'one',
  slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
});
const event = () => ({
  tenantId,
  channelId: 'channel',
  agentId: 'agent',
  principal: { userId: 'owner', channelRevision: 'one' },
  admission: {
    eventId: 'event',
    externalChannelId: 'C1',
    externalThreadKey: 'C1:1',
    externalMessageKey: 'C1:2',
    actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
    input: 'private input',
  },
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createAgentChannelMethods(mongoose);
  runs = createChannelRunStorage(mongoose);
});
beforeEach(async () =>
  runAsSystem(async () => {
    for (const name of [
      'AgentChannel',
      'AgentChannelThread',
      'ChannelIdentity',
      'ChannelScope',
      'ChannelRun',
      'ChannelLane',
    ])
      await mongoose.models[name].deleteMany({});
  }),
);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

it('builds unique connection indexes before concurrent first writes', () =>
  scope(async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => methods.createAgentChannel(channel())),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await mongoose.models.AgentChannel.countDocuments({ channelId: 'channel' })).toBe(1);
  }));

it('keeps a deleting parent until admitted work drains and rejects delayed admissions', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    await runs.admit(event(), 100);
    expect(await methods.deleteAgentChannel('channel', 'owner')).toBe(false);
    expect(await methods.getAgentChannel('channel')).toMatchObject({ status: 'deleting' });
    await expect(
      runs.admit({ ...event(), admission: { ...event().admission, eventId: 'late' } }, 101),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await methods.updateAgentChannel('channel', 'owner', { status: 'active' })).toBeNull();
    expect(
      await methods.updateAgentChannel('channel', 'owner', { status: 'active' }, 'deleting'),
    ).toBeNull();
    await mongoose.models.ChannelRun.updateMany({}, { $set: { state: 'cancelled' } });
    expect(await methods.deleteAgentChannel('channel', 'owner')).toBe(true);
    await expect(runs.admit(event(), 102)).rejects.toMatchObject({ code: 'invalid_transition' });
  }));

it('waits for an inserting admission before deciding whether deletion can finish', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.ChannelRun.collection;
    const insert = collection.insertOne.bind(collection);
    const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return insert(...args);
    });
    const admission = runs.admit(event(), 100);
    await started;
    let finished = false;
    const deletion = methods.deleteAgentChannel('channel', 'owner').then((result) => {
      finished = true;
      return result;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finished).toBe(false);
    } finally {
      release();
      paused.mockRestore();
    }
    expect(await admission).toMatchObject({ duplicate: false });
    expect(await deletion).toBe(false);
    expect(await methods.getAgentChannel('channel')).toMatchObject({ status: 'deleting' });
  }));

it('leaves deletion retryable after dependent erasure fails', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    await mongoose.models.AgentChannelThread.create({
      tenantId,
      channelId: 'channel',
      externalThreadKey: 'thread',
      conversationId: 'legacy-conversation',
    });
    jest
      .spyOn(mongoose.models.AgentChannelThread.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('mapping erasure failed'));
    await expect(methods.deleteAgentChannel('channel', 'owner')).rejects.toThrow(
      'mapping erasure failed',
    );
    expect(await mongoose.models.AgentChannelThread.countDocuments({ channelId: 'channel' })).toBe(
      1,
    );
    expect(await methods.getAgentChannel('channel')).toMatchObject({ status: 'deleting' });
    await expect(runs.admit(event(), 100)).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await methods.deleteAgentChannel('channel', 'owner')).toBe(true);
    expect(await mongoose.models.AgentChannelThread.countDocuments({ channelId: 'channel' })).toBe(
      0,
    );
  }));

it('does not close admission when a different owner requests deletion', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    expect(await methods.deleteAgentChannel('channel', 'intruder')).toBe(false);
    expect(await runs.admit(event(), 100)).toMatchObject({ duplicate: false });
  }));

it('erases a credential creation already admitted before account deletion', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'connection-owner@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = mongoose.models.AgentChannel.collection;
    const insert = collection.insertOne.bind(collection);
    const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return insert(...args);
    });
    const creation = methods.createAgentChannel({
      ...channel(),
      createdBy: userId,
      encryptedBotToken: 'private-bot-token',
      encryptedSigningSecret: 'private-signing-secret',
    });
    await started;
    let finished = false;
    const deletion = createUserMethods(mongoose)
      .deleteUserById(userId)
      .then((result) => {
        finished = true;
        return result;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finished).toBe(false);
    } finally {
      release();
      paused.mockRestore();
    }
    await creation;
    await deletion;
    expect(await methods.getAgentChannel('channel')).toBeNull();
    await expect(
      methods.createAgentChannel({
        ...channel(),
        channelId: 'late',
        createdBy: userId,
        encryptedBotToken: 'late-private-token',
      }),
    ).rejects.toThrow('owner unavailable');
  }));

it('redacts deleted-owner credentials while retaining a retry anchor for other principals', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'shared-connection-owner@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    await methods.createAgentChannel({
      ...channel(),
      createdBy: userId,
      credentialMode: 'per_user',
      encryptedBotToken: 'private-bot-token',
      encryptedSigningSecret: 'private-signing-secret',
      encryptedApiKey: 'private-key',
      apiKeyId: 'private-key-id',
    });
    await createChannelIdentityStorage(mongoose).saveChannelIdentity(
      {
        ...linkRecord(tenantId, 'channel', 'other-link'),
        userId: 'other-principal',
        identity: {
          ...linkRecord(tenantId, 'channel', 'other-link').identity,
          externalUserId: 'U1',
        },
      },
      null,
    );
    const other = await runs.admit(
      {
        ...event(),
        principal: {
          ...event().principal,
          userId: 'other-principal',
          linkId: 'other-link',
          linkRevision: 'one',
        },
      },
      100,
    );
    await mongoose.models.AgentChannelThread.create({
      tenantId,
      channelId: 'channel',
      externalThreadKey: 'thread',
      conversationId: 'legacy-conversation',
    });
    await createUserMethods(mongoose).deleteUserById(userId);
    const parent = await methods.getAgentChannel('channel');
    expect(parent).toMatchObject({ status: 'deleting' });
    for (const field of [
      'encryptedBotToken',
      'encryptedSigningSecret',
      'encryptedApiKey',
      'apiKeyId',
    ])
      expect(parent).not.toHaveProperty(field);
    expect(await mongoose.models.AgentChannelThread.countDocuments({ channelId: 'channel' })).toBe(
      0,
    );
    expect(await runs.read(tenantId, 'channel', other.run.runId)).not.toBeNull();
    await expect(
      runs.admit({ ...event(), admission: { ...event().admission, eventId: 'late' } }, 101),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await mongoose.models.ChannelRun.updateOne(
      { runId: other.run.runId },
      { $set: { state: 'cancelled' } },
    );
    expect(await methods.deleteAgentChannel('channel', userId)).toBe(true);
  }));

it('keeps account erasure retryable after connection mapping cleanup fails', () =>
  scope(async () => {
    const user = await mongoose.models.User.create({
      email: 'connection-erasure-retry@example.com',
      provider: 'local',
      tenantId,
    });
    const userId = String(user._id);
    await methods.createAgentChannel({
      ...channel(),
      createdBy: userId,
      encryptedBotToken: 'private-token',
    });
    await mongoose.models.AgentChannelThread.create({
      tenantId,
      channelId: 'channel',
      externalThreadKey: 'thread',
      conversationId: 'legacy-conversation',
    });
    jest
      .spyOn(mongoose.models.AgentChannelThread.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('mapping store unavailable'));
    const users = createUserMethods(mongoose);
    await expect(users.deleteUserById(userId)).rejects.toThrow('mapping store unavailable');
    expect(await mongoose.models.User.findById(userId).lean()).not.toBeNull();
    expect(await methods.getAgentChannel('channel')).not.toHaveProperty('encryptedBotToken');
    expect(await mongoose.models.AgentChannelThread.countDocuments({ channelId: 'channel' })).toBe(
      1,
    );
    await expect(users.deleteUserById(userId)).resolves.toMatchObject({ deletedCount: 1 });
    expect(await mongoose.models.AgentChannelThread.countDocuments({ channelId: 'channel' })).toBe(
      0,
    );
    expect(await methods.getAgentChannel('channel')).toBeNull();
  }));

function linkRecord(
  partition: string,
  channelId: string,
  linkId: string,
  state: ChannelIdentityRecord['state'] = 'active',
): ChannelIdentityRecord {
  return {
    tenantId: partition,
    linkId,
    revision: 'one',
    state,
    ticketHash: `hash-${linkId}`,
    ticketExpiresAtMs: Date.now() + 60_000,
    expiresAtMs: Date.now() + 120_000,
    ...(state === 'pending' ? {} : { userId: 'linked-user', accountLabel: 'Linked user' }),
    identity: {
      tenantId: partition,
      channelId,
      channelRevision: 'one',
      teamId: 'T1',
      externalUserId: linkId,
      agentId: 'agent',
    },
  };
}

it('requires the retirement operation for deletion transitions and blocks updates of deleting rows', () =>
  scope(async () => {
    await expect(
      methods.createAgentChannel({ ...channel(), channelId: 'invalid-create', status: 'deleting' }),
    ).rejects.toThrow('requires retirement');
    expect(await methods.getAgentChannel('invalid-create')).toBeNull();
    await methods.createAgentChannel({ ...channel(), apiKeyId: 'original-key' });
    expect(await methods.updateAgentChannel('channel', 'owner', { status: 'deleting' })).toBeNull();
    expect((await methods.getAgentChannel('channel'))?.status).toBe('active');
    await runs.admit(event(), 100);
    expect(await methods.beginAgentChannelDeletion('channel', 'owner')).toMatchObject({
      status: 'deleting',
      apiKeyId: 'original-key',
    });
    expect(await methods.deleteAgentChannel('channel', 'owner')).toBe(false);
    expect(
      await methods.updateAgentChannel(
        'channel',
        'owner',
        { encryptedBotToken: 'late-secret' },
        'deleting',
      ),
    ).toBeNull();
    expect(
      await methods.updateAgentChannel('channel', 'owner', { revision: 'late' }, 'deleting'),
    ).toBeNull();
    expect(await methods.getAgentChannel('channel')).not.toHaveProperty('encryptedBotToken');
  }));

it('retires every linked identity before completing direct channel deletion', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    const identities = createChannelIdentityStorage(mongoose);
    for (const state of ['pending', 'accepted', 'active'] as const) {
      expect(
        await identities.saveChannelIdentity(linkRecord(tenantId, 'channel', state, state), null),
      ).toBe(true);
    }
    expect(await methods.deleteAgentChannel('channel', 'owner')).toBe(true);
    expect(await identities.listChannelLinks(tenantId, 'linked-user')).toEqual([]);
    expect(
      await mongoose.models.ChannelIdentity.countDocuments({
        tenantId,
        'identity.channelId': 'channel',
      }),
    ).toBe(0);
    expect(
      await identities.saveChannelIdentity(
        linkRecord(tenantId, 'channel', 'late', 'pending'),
        null,
      ),
    ).toBe(false);
  }));

it('keeps identity retirement failure retryable without reopening admission', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    const identities = createChannelIdentityStorage(mongoose);
    await identities.saveChannelIdentity(linkRecord(tenantId, 'channel', 'link'), null);
    jest
      .spyOn(mongoose.models.ChannelIdentity.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('identity cleanup unavailable'));
    await expect(methods.deleteAgentChannel('channel', 'owner')).rejects.toThrow(
      'identity cleanup unavailable',
    );
    expect((await methods.getAgentChannel('channel'))?.status).toBe('deleting');
    expect(
      await identities.saveChannelIdentity(
        linkRecord(tenantId, 'channel', 'late', 'pending'),
        null,
      ),
    ).toBe(false);
    expect(await methods.deleteAgentChannel('channel', 'owner')).toBe(true);
    expect(await identities.listChannelLinks(tenantId, 'linked-user')).toEqual([]);
  }));

it.each([tenantId, undefined])(
  'erases other principals links for an account-owned channel in partition %s',
  (activeTenant) =>
    tenantStorage.run({ tenantId: activeTenant }, async () => {
      const partition = activeTenant ?? '_';
      const user = await mongoose.models.User.create({
        email: `channel-cascade-${partition}@example.com`,
        provider: 'local',
        tenantId: activeTenant,
      });
      const ownerId = String(user._id);
      await methods.createAgentChannel({
        ...channel(),
        tenantId: activeTenant,
        createdBy: ownerId,
        credentialMode: 'per_user',
      });
      await methods.createAgentChannel({
        ...channel(),
        tenantId: activeTenant,
        channelId: 'other-channel',
        createdBy: 'other-owner',
      });
      const identities = createChannelIdentityStorage(mongoose);
      for (const state of ['pending', 'accepted', 'active'] as const) {
        expect(
          await identities.saveChannelIdentity(
            linkRecord(partition, 'channel', state, state),
            null,
          ),
        ).toBe(true);
      }
      await identities.saveChannelIdentity(
        linkRecord(partition, 'other-channel', 'other-channel-link'),
        null,
      );
      await runAsSystem(async () => {
        await mongoose.models.ChannelIdentity.create(
          linkRecord('foreign-tenant', 'channel', 'foreign-link'),
        );
      });
      const admitted = await runs.admit(
        {
          ...event(),
          tenantId: partition,
          principal: {
            userId: 'linked-user',
            channelRevision: 'one',
            linkId: 'active',
            linkRevision: 'one',
          },
          admission: {
            ...event().admission,
            actor: { ...event().admission.actor, externalUserId: 'active' },
          },
        },
        100,
      );
      await createUserMethods(mongoose).deleteUserById(ownerId);
      expect((await methods.getAgentChannel('channel'))?.status).toBe('deleting');
      expect(
        (await identities.listChannelLinks(partition, 'linked-user')).map((link) => link.linkId),
      ).toEqual(['other-channel-link']);
      expect(
        await identities.saveChannelIdentity(
          linkRecord(partition, 'channel', 'late', 'pending'),
          null,
        ),
      ).toBe(false);
      expect(
        await mongoose.models.ChannelIdentity.countDocuments({
          tenantId: partition,
          'identity.channelId': 'channel',
        }),
      ).toBe(0);
      await runAsSystem(async () => {
        expect(
          await mongoose.models.ChannelIdentity.countDocuments({
            tenantId: 'foreign-tenant',
            linkId: 'foreign-link',
          }),
        ).toBe(1);
      });
      expect(await runs.read(partition, 'channel', admitted.run.runId)).not.toBeNull();
      await mongoose.models.ChannelRun.updateOne(
        { runId: admitted.run.runId },
        { $set: { state: 'cancelled' } },
      );
      expect(await methods.deleteAgentChannel('channel', ownerId)).toBe(true);
    }),
);

it('treats an empty revision as an exact CAS token rather than an absent guard', () =>
  scope(async () => {
    await methods.createAgentChannel({ ...channel(), revision: '' });
    const updates = await Promise.all(
      ['one', 'two', 'three', 'four'].map((revision) =>
        methods.updateAgentChannel('channel', 'owner', { revision }, undefined, ''),
      ),
    );
    const winners = updates.filter((record) => record !== null);
    expect(winners).toHaveLength(1);
    expect((await methods.getAgentChannel('channel'))?.revision).toBe(winners[0]?.revision);
    expect(
      await methods.updateAgentChannel('channel', 'owner', { revision: 'stale' }, undefined, ''),
    ).toBeNull();
    expect(
      await methods.updateAgentChannel(
        'channel',
        'owner',
        { status: 'disabled' },
        undefined,
        undefined,
      ),
    ).toMatchObject({ status: 'disabled' });
  }));
