import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { AgentChannelRecord } from './channel';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
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

it('builds mapping indexes and serializes concurrent first mappings', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    await Promise.all(
      Array.from({ length: 8 }, () =>
        methods.putAgentChannelThread('channel', 'thread', 'conversation'),
      ),
    );
    expect(
      await mongoose.models.AgentChannelThread.countDocuments({
        channelId: 'channel',
        externalThreadKey: 'thread',
      }),
    ).toBe(1);
    expect(await methods.getAgentChannelThread('channel', 'thread')).toMatchObject({
      conversationId: 'conversation',
    });
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

it('drains a concurrent mapping write before erasing mappings and the parent', () =>
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
    const collection = mongoose.models.AgentChannelThread.collection;
    const update = collection.updateOne.bind(collection);
    const paused = jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
      entered();
      await gate;
      return update(...args);
    });
    const mapping = methods.putAgentChannelThread('channel', 'thread', 'conversation');
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
    await mapping;
    expect(await deletion).toBe(true);
    expect(await methods.getAgentChannelThread('channel', 'thread')).toBeNull();
    await expect(methods.putAgentChannelThread('channel', 'late', 'conversation')).rejects.toThrow(
      'authority unavailable',
    );
  }));

it('leaves deletion retryable after dependent erasure fails', () =>
  scope(async () => {
    await methods.createAgentChannel(channel());
    await methods.putAgentChannelThread('channel', 'thread', 'conversation');
    jest
      .spyOn(mongoose.models.AgentChannelThread.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('mapping erasure failed'));
    await expect(methods.deleteAgentChannel('channel', 'owner')).rejects.toThrow(
      'mapping erasure failed',
    );
    expect(await methods.getAgentChannel('channel')).toMatchObject({ status: 'deleting' });
    await expect(runs.admit(event(), 100)).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await methods.deleteAgentChannel('channel', 'owner')).toBe(true);
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
      encryptedBotToken: 'private-bot-token',
      encryptedSigningSecret: 'private-signing-secret',
      encryptedApiKey: 'private-key',
      apiKeyId: 'private-key-id',
    });
    const other = await runs.admit(
      { ...event(), principal: { ...event().principal, userId: 'other-principal' } },
      100,
    );
    await methods.putAgentChannelThread('channel', 'thread', 'conversation');
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
    expect(await methods.getAgentChannelThread('channel', 'thread')).toBeNull();
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
    await methods.putAgentChannelThread('channel', 'thread', 'conversation');
    jest
      .spyOn(mongoose.models.AgentChannelThread.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('mapping store unavailable'));
    const users = createUserMethods(mongoose);
    await expect(users.deleteUserById(userId)).rejects.toThrow('mapping store unavailable');
    expect(await mongoose.models.User.findById(userId).lean()).not.toBeNull();
    expect(await methods.getAgentChannel('channel')).not.toHaveProperty('encryptedBotToken');
    await expect(users.deleteUserById(userId)).resolves.toMatchObject({ deletedCount: 1 });
    expect(await methods.getAgentChannel('channel')).toBeNull();
  }));
