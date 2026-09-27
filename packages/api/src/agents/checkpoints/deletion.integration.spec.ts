import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { openCheckpointDeletion, createCheckpointDeletionReclaimer } from './deletion';
import { createCheckpointNamespace } from '../../stream/checkpoints';
import { deleteOwnedAgentCheckpoints } from '../checkpointer';

let server: MongoMemoryServer;
const cfg = {
  type: 'mongo' as const,
  checkpointCollectionName: 'cleanup_cp',
  checkpointWritesCollectionName: 'cleanup_writes',
};

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.connection.db!.dropDatabase();
});

test('cleanup identity survives absent jobs and missing TTL indexes', async () => {
  const ns = createCheckpointNamespace('owner', 'tenant');
  const other = createCheckpointNamespace('other', 'tenant');
  const otherTenant = createCheckpointNamespace('owner', 'other-tenant');
  const rows = [ns, `${ns}|child`, other, otherTenant, '', '1000'].map((checkpoint_ns) => ({
    thread_id: 'thread',
    checkpoint_ns,
  }));
  for (const name of ['cleanup_cp', 'cleanup_writes']) {
    await mongoose.connection.db!.collection(name).insertMany(rows.map((row) => ({ ...row })));
  }
  await deleteOwnedAgentCheckpoints('owner', 'tenant', ['thread'], cfg);
  await deleteOwnedAgentCheckpoints('owner', 'tenant', ['thread'], cfg);
  for (const name of ['cleanup_cp', 'cleanup_writes']) {
    const remaining = await mongoose.connection.db!.collection(name).find().toArray();
    expect(remaining.map((row) => row.checkpoint_ns).sort()).toEqual(
      [other, otherTenant, '', '1000'].sort(),
    );
  }
});

test('account cleanup remains retryable after one collection deletion fails', async () => {
  const checkpoint_ns = createCheckpointNamespace('owner');
  for (const name of ['cleanup_cp', 'cleanup_writes']) {
    await mongoose.connection.db!.collection(name).insertOne({ thread_id: 'gone', checkpoint_ns });
  }
  jest
    .spyOn(mongoose.mongo.Collection.prototype, 'deleteMany')
    .mockRejectedValueOnce(new Error('temporary failure'));
  await expect(deleteOwnedAgentCheckpoints('owner', undefined, undefined, cfg)).rejects.toThrow(
    'temporary failure',
  );
  jest.restoreAllMocks();
  await deleteOwnedAgentCheckpoints('owner', undefined, undefined, cfg);
  expect(await mongoose.connection.db!.collection('cleanup_cp').countDocuments()).toBe(0);
  expect(await mongoose.connection.db!.collection('cleanup_writes').countDocuments()).toBe(0);
});

test('deletion intent retains every cascade wave across retries and scopes owners and roots', async () => {
  const first = await openCheckpointDeletion('owner', 'tenant', 'root', cfg);
  await first.remember(['root']);
  await first.remember(['child', 'grandchild']);
  const retry = await openCheckpointDeletion('owner', 'tenant', 'root', cfg);
  expect(retry.conversationIds().sort()).toEqual(['child', 'grandchild', 'root']);
  expect((await openCheckpointDeletion('other', 'tenant', 'root', cfg)).conversationIds()).toEqual(
    [],
  );
  expect((await openCheckpointDeletion('owner', 'other', 'root', cfg)).conversationIds()).toEqual(
    [],
  );
  expect(
    (await openCheckpointDeletion('owner', 'tenant', 'other-root', cfg)).conversationIds(),
  ).toEqual([]);
  await retry.acknowledge();
  expect((await openCheckpointDeletion('owner', 'tenant', 'root', cfg)).conversationIds()).toEqual(
    [],
  );
});

test('an earlier attempt cannot acknowledge a newer attempt’s intent', async () => {
  const first = await openCheckpointDeletion('owner', undefined, 'root', cfg);
  await first.remember(['child']);
  const second = await openCheckpointDeletion('owner', undefined, 'root', cfg);
  await second.remember(['child']);
  await first.acknowledge();
  expect((await openCheckpointDeletion('owner', undefined, 'root', cfg)).conversationIds()).toEqual(
    ['child'],
  );
  await second.acknowledge();
});

test('thousands of conversation targets use bounded cleanup commands', async () => {
  const ids = Array.from({ length: 1100 }, (_, i) => `thread-${i}`);
  const intent = await openCheckpointDeletion('owner', undefined, 'root', cfg);
  await intent.remember(ids);
  const ns = createCheckpointNamespace('owner');
  await mongoose.connection
    .db!.collection('cleanup_cp')
    .insertMany(ids.map((thread_id) => ({ thread_id, checkpoint_ns: ns })));
  const spy = jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany');
  await deleteOwnedAgentCheckpoints('owner', undefined, ids, cfg);
  expect(spy.mock.calls.every(([filter]) => filter?.thread_id.$in.length <= 256)).toBe(true);
  expect(await mongoose.connection.db!.collection('cleanup_cp').countDocuments()).toBe(0);
  await intent.acknowledge();
  expect(
    (await openCheckpointDeletion('owner', undefined, undefined, cfg)).conversationIds(),
  ).toEqual([]);
});

test('snapshots legacy references without per-reference ownership lookups', async () => {
  const ids = Array.from({ length: 257 }, (_, i) => `thread-${i}`);
  await mongoose.connection.db!.collection('conversations').insertMany(
    ids.map((conversationId) => ({
      user: 'owner',
      conversationId,
      subagentThread: {},
      agentEventActorCleanup: Array.from({ length: 4 }, (_, i) => ({
        threadId: conversationId,
        checkpointNs: `event-actor/${i}`,
        checkpointId: `checkpoint-${i}`,
      })),
    })),
  );
  const deletion = await openCheckpointDeletion('owner', undefined, 'root', cfg);
  const find = jest.spyOn(mongoose.mongo.Collection.prototype, 'find');
  const findOne = jest.spyOn(mongoose.mongo.Collection.prototype, 'findOne');
  await deletion.remember(ids);
  const scopeReads = find.mock.calls.filter(
    (_, index) => find.mock.contexts[index].collectionName === 'cleanup_cp_actor_owners',
  );
  expect(scopeReads).toHaveLength(0);
  expect(
    findOne.mock.calls.filter(
      (_, index) => findOne.mock.contexts[index].collectionName === 'cleanup_cp_actor_owners',
    ),
  ).toHaveLength(0);
  expect(deletion.conversationIds()).toHaveLength(257);
  const deletionCommands = jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany');
  await deletion.cleanup();
  const exactCommands = deletionCommands.mock.calls.filter(([filter]) => filter?.$and != null);
  expect(exactCommands).toHaveLength(10);
  expect(
    exactCommands.every(([filter]) => (filter?.$and?.[1]?.$or?.length ?? Infinity) <= 256),
  ).toBe(true);
  expect(
    await mongoose.connection.db!.collection('agent_checkpoint_deletions').countDocuments(),
  ).toBe(257 * 5);
});

test('memory checkpointer conversations can still record and acknowledge deletion intent', async () => {
  const memory = { ...cfg, type: 'memory' as const };
  const deletion = await openCheckpointDeletion('owner', undefined, 'thread', memory);
  await deletion.remember(['thread']);
  await deletion.cleanup();
  await deletion.acknowledge();
  expect(
    await mongoose.connection.db!.collection('agent_checkpoint_deletions').countDocuments(),
  ).toBe(0);
});

test('reclaims only empty recorded stores and discovers remaining work across configurations', async () => {
  const other = {
    ...cfg,
    checkpointCollectionName: 'custom_cp',
    checkpointWritesCollectionName: 'custom_writes',
  };
  for (const storage of [cfg, other]) {
    const deletion = await openCheckpointDeletion('owner', 'tenant', 'root', storage);
    await deletion.remember(['child']);
  }
  const db = mongoose.connection.db!;
  await db
    .collection('custom_writes')
    .insertOne({ thread_id: 'child', checkpoint_ns: createCheckpointNamespace('owner', 'tenant') });
  const getJobs = jest.fn().mockResolvedValue([]);
  const reclaim = createCheckpointDeletionReclaimer(getJobs);
  expect(await reclaim(25)).toBe(1);
  expect(getJobs).toHaveBeenCalledTimes(1);
  expect((await openCheckpointDeletion('owner', 'tenant', 'root', cfg)).conversationIds()).toEqual([
    'child',
  ]);
  expect(
    (await openCheckpointDeletion('owner', 'tenant', 'root', other)).conversationIds(),
  ).toEqual(['child']);
  await db.collection('custom_writes').deleteMany({});
  expect(await reclaim(25)).toBe(1);
});

test.each(['conversations', 'messages', 'toolcalls', 'sharedlinks'])(
  'retains cascade identity while %s work survives',
  async (name) => {
    const db = mongoose.connection.db!;
    const userId = new mongoose.Types.ObjectId().toString();
    const deletion = await openCheckpointDeletion(userId, undefined, 'root', cfg);
    await deletion.remember(['child']);
    await db.collection(name).insertOne({
      user: name === 'toolcalls' ? new mongoose.Types.ObjectId(userId) : userId,
      conversationId: 'child',
    });
    const reclaim = createCheckpointDeletionReclaimer(async () => []);
    expect(await reclaim(25)).toBe(0);
    await db.collection(name).deleteMany({});
    expect(await reclaim(25)).toBe(1);
  },
);

test('replays exact legacy proof without TTL indexes and rotates past retained work', async () => {
  const db = mongoose.connection.db!;
  const checkpoint = {
    threadId: 'child',
    checkpointNs: 'event-actor/legacy',
    checkpointId: 'exact',
  };
  await db.collection('conversations').insertOne({
    user: 'owner',
    conversationId: 'child',
    subagentThread: {},
    agentEventActorCleanup: [checkpoint],
  });
  const deletion = await openCheckpointDeletion('owner', undefined, 'root', cfg);
  await deletion.remember(['child', 'empty']);
  await db.collection('conversations').deleteMany({});
  await db.collection('cleanup_writes').insertOne({
    thread_id: 'child',
    checkpoint_ns: checkpoint.checkpointNs,
    checkpoint_id: checkpoint.checkpointId,
  });
  const reclaim = createCheckpointDeletionReclaimer(async () => []);
  for (let pass = 0; pass < 6; pass++) await reclaim(1);
  expect(await db.collection('cleanup_writes').countDocuments()).toBe(0);
  expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(0);
});

test('retains writer obligations, renewed revisions, and lookup failures', async () => {
  const deletion = await openCheckpointDeletion('owner', undefined, 'root', cfg);
  await deletion.remember(['child']);
  const getJobs = jest.fn().mockResolvedValue(['pending-host']);
  const reclaim = createCheckpointDeletionReclaimer(getJobs);
  const activity = { found: false };
  expect(await reclaim(25, activity)).toBe(0);
  expect(activity.found).toBe(true);
  getJobs.mockRejectedValueOnce(new Error('job store unavailable'));
  await expect(reclaim(25)).rejects.toThrow('reclamation failed');
  getJobs.mockImplementationOnce(async () => {
    const renewed = await openCheckpointDeletion('owner', undefined, 'root', cfg);
    await renewed.remember(['child']);
    return [];
  });
  expect(await reclaim(25)).toBe(0);
  expect((await openCheckpointDeletion('owner', undefined, 'root', cfg)).conversationIds()).toEqual(
    ['child'],
  );
  getJobs.mockResolvedValue([]);
  expect(await reclaim(25)).toBe(1);
});

test('current-tenant deletion recovers tenantless ownership and exact references without erasing another tenant', async () => {
  const db = mongoose.connection.db!;
  const current = createCheckpointNamespace('owner', 'tenant-a');
  const legacy = createCheckpointNamespace('owner');
  const foreign = createCheckpointNamespace('owner', 'tenant-b');
  const refs = [
    { thread_id: 'legacy-thread', checkpoint_ns: 'event-actor/legacy', checkpoint_id: 'proved' },
    { thread_id: 'legacy-thread', checkpoint_ns: 'event-actor/legacy', checkpoint_id: 'unproved' },
  ];
  for (const name of ['cleanup_cp', 'cleanup_writes']) {
    await db
      .collection(name)
      .insertMany([
        { thread_id: 'current-thread', checkpoint_ns: current },
        { thread_id: 'legacy-thread', checkpoint_ns: legacy },
        { thread_id: 'foreign-thread', checkpoint_ns: foreign },
        ...refs,
      ]);
  }
  await db.collection('conversations').insertOne({
    user: 'owner',
    conversationId: 'legacy-thread',
    subagentThread: {},
    agentEventActorCleanup: [
      { threadId: 'legacy-thread', checkpointNs: 'event-actor/legacy', checkpointId: 'proved' },
    ],
  });
  const deletion = await openCheckpointDeletion('owner', 'tenant-a', undefined, cfg);
  await deletion.remember(['current-thread', 'legacy-thread']);
  await db.collection('conversations').deleteMany({ user: 'owner' });
  const retry = await openCheckpointDeletion('owner', 'tenant-a', undefined, cfg);
  expect(retry.conversationIds().sort()).toEqual(['current-thread', 'legacy-thread']);
  await retry.cleanup();
  await retry.acknowledge();
  for (const name of ['cleanup_cp', 'cleanup_writes']) {
    const rows = await db.collection(name).find().toArray();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.checkpoint_ns)).toEqual([foreign, 'event-actor/legacy']);
    expect(rows.find((row) => row.checkpoint_id)?.checkpoint_id).toBe('unproved');
  }
  expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(0);
});

test.each(['mongo', 'memory'] as const)(
  'replays a failed cascade against recorded stores after switching to %s',
  async (type) => {
    const db = mongoose.connection.db!;
    const next = {
      type,
      checkpointCollectionName: 'next_cp',
      checkpointWritesCollectionName: 'next_writes',
    };
    const ns = createCheckpointNamespace('owner', 'tenant');
    const foreign = createCheckpointNamespace('foreign', 'tenant');
    for (const name of ['cleanup_cp', 'cleanup_writes', 'next_cp', 'next_writes']) {
      await db.collection(name).insertMany([
        { thread_id: 'child', checkpoint_ns: ns },
        { thread_id: 'child', checkpoint_ns: foreign },
        { thread_id: 'unrelated', checkpoint_ns: ns },
      ]);
    }
    const original = await openCheckpointDeletion('owner', 'tenant', 'root', cfg);
    await original.remember(['child']);
    const attempt = await openCheckpointDeletion('owner', 'tenant', 'root', next);
    expect(attempt.conversationIds()).toEqual(['child']);
    await attempt.remember(attempt.conversationIds());
    const remove = mongoose.mongo.Collection.prototype.deleteMany;
    jest
      .spyOn(mongoose.mongo.Collection.prototype, 'deleteMany')
      .mockImplementationOnce(async () => {
        throw new Error('store unavailable');
      });
    await expect(attempt.cleanup()).rejects.toThrow('store unavailable');
    jest.restoreAllMocks();
    expect(remove).toBe(mongoose.mongo.Collection.prototype.deleteMany);
    expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(2);
    const retry = await openCheckpointDeletion('owner', 'tenant', 'root', next);
    await retry.cleanup();
    for (const name of [
      'cleanup_cp',
      'cleanup_writes',
      ...(type === 'mongo' ? ['next_cp', 'next_writes'] : []),
    ]) {
      expect(
        await db
          .collection(name)
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      ).toEqual([
        { thread_id: 'child', checkpoint_ns: foreign },
        { thread_id: 'unrelated', checkpoint_ns: ns },
      ]);
    }
    await retry.acknowledge();
    expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(0);
  },
);

test('a failed owner deletion leaves no sibling delete running when the fence can reopen', async () => {
  const db = mongoose.connection.db!;
  const intent = await openCheckpointDeletion('owner', 'tenant', undefined, cfg);
  await intent.remember(['thread']);
  const remove = mongoose.mongo.Collection.prototype.deleteMany;
  const writesStarted = jest.fn();
  let releaseWrites!: () => void;
  const heldWrites = new Promise<void>((resolve) => {
    releaseWrites = resolve;
  });
  jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany').mockImplementation(async function (
    this: InstanceType<typeof mongoose.mongo.Collection>,
    filter,
    options,
  ) {
    if (this.collectionName === 'cleanup_cp') throw new Error('checkpoint delete failed');
    writesStarted();
    await heldWrites;
    return remove.call(this, filter, options);
  });
  try {
    await expect(intent.cleanup()).rejects.toThrow('checkpoint delete failed');
    expect(writesStarted).not.toHaveBeenCalled();
    expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(1);
  } finally {
    releaseWrites();
    jest.restoreAllMocks();
  }
  await intent.cleanup();
  await intent.acknowledge();
});
