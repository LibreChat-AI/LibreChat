import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createResponseCheckpointCleanupGuard } from '@librechat/data-schemas';
import {
  createResponseStorage,
  createManagedMessageId,
  createManagedConversationId,
  responseReference,
  tenantStorage,
} from '@librechat/data-schemas';
import { createCheckpointNamespace } from '../../stream/checkpoints';
import { deleteOwnedAgentCheckpoints } from '../checkpointer';
import { createCheckpointDeletionService } from './deletion';

const { openCheckpointDeletion, createCheckpointDeletionReclaimer } =
  createCheckpointDeletionService(createResponseCheckpointCleanupGuard(mongoose));

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

async function unresolvedResponse(
  owner: { userId: string; tenantId?: string } = {
    userId: 'pending-response-owner',
    tenantId: 'pending-response-tenant',
  },
) {
  return tenantStorage.run(owner, async () => {
    const storage = createResponseStorage(mongoose);
    const reserved = await storage.reserve({
      ...owner,
      responseId: createManagedMessageId(),
      conversationId: createManagedConversationId(),
      agentId: 'agent',
      requestKey: randomUUID(),
      fingerprint: randomUUID(),
      requestJSON: '{"input":"private response request"}',
      parentMessageId: 'root',
    });
    if (!reserved.ok) throw new Error('Reservation failed');
    const binding = { generationCreatedAt: Date.now(), providerExecutionId: randomUUID() };
    const enrolled = await storage.enrollExecution(reserved.record, binding, '{}');
    if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, binding)))
      throw new Error('Enrollment failed');
    const namespace = createCheckpointNamespace(owner.userId, owner.tenantId);
    const writer = storage.createCheckpointWriter(responseReference(enrolled.record), {
      ...binding,
      writerId: randomUUID(),
      namespace,
      configJSON: JSON.stringify(cfg),
    });
    expect(await writer.open()).toBe(true);
    await mongoose.models.StoredResponse.updateOne(
      { responseId: reserved.record.responseId },
      { $set: { expiredAt: new Date(0) } },
    );
    expect(await storage.retireExecution(enrolled.record)).toBe(true);
    return { owner, record: enrolled.record, namespace, writer, storage, binding };
  });
}

test.each(['cleanup', 'acknowledge'] as const)(
  'keeps %s pending while an expired retired Response Root owns an unsettled writer',
  async (operation) => {
    const f = await unresolvedResponse();
    const db = mongoose.connection.db!;
    await db.collection('cleanup_cp').insertOne({
      thread_id: f.record.conversationId,
      checkpoint_ns: f.namespace,
      checkpoint_id: 'private',
      payload: 'private checkpoint',
    });
    const deletion = await openCheckpointDeletion(
      f.owner.userId,
      f.owner.tenantId,
      f.record.conversationId,
      cfg,
    );
    await deletion.remember([f.record.conversationId]);
    await expect(deletion[operation]()).rejects.toMatchObject({ code: 'response_erasure_pending' });
    expect(await db.collection('cleanup_cp').countDocuments()).toBe(1);
    expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBeGreaterThan(0);
    expect(
      await tenantStorage.run(f.owner, () => f.storage.read(f.record, f.record.responseId)),
    ).toBeNull();
    expect(
      await db
        .collection(mongoose.models.StoredResponse.collection.name)
        .findOne({ responseId: f.record.responseId }),
    ).not.toBeNull();
  },
);

test('retains deletion evidence despite empty checkpoints and absent jobs while a Response writer remains unresolved', async () => {
  const f = await unresolvedResponse();
  const deletion = await openCheckpointDeletion(
    f.owner.userId,
    f.owner.tenantId,
    f.record.conversationId,
    cfg,
  );
  await deletion.remember([f.record.conversationId]);
  const reclaim = createCheckpointDeletionReclaimer(async () => []);
  expect(await reclaim(25)).toBe(0);
  expect(
    await mongoose.connection.db!.collection('agent_checkpoint_deletions').countDocuments(),
  ).toBeGreaterThan(0);
  await mongoose.connection.db!.collection('cleanup_writes').insertOne({
    thread_id: f.record.conversationId,
    checkpoint_ns: f.namespace,
    checkpoint_id: 'delayed',
    payload: 'late private checkpoint',
  });
  expect(await reclaim(25)).toBe(0);
  expect(await mongoose.connection.db!.collection('cleanup_writes').countDocuments()).toBe(1);
});

test('allows cleanup and receipt acknowledgement after the actual Response owner finishes erasure', async () => {
  const f = await unresolvedResponse();
  const deletion = await openCheckpointDeletion(f.owner.userId, f.owner.tenantId, undefined, cfg);
  await deletion.remember([f.record.conversationId]);
  await expect(deletion.cleanup()).rejects.toMatchObject({ code: 'response_erasure_pending' });
  await tenantStorage.run(f.owner, async () => {
    expect(await f.writer.settle()).toBe(true);
    expect(await f.storage.settleExecution(responseReference(f.record), f.binding, 'aborted')).toBe(
      true,
    );
    const proof = await f.storage.readExecutionProof(f.record);
    if (!proof) throw new Error('Missing exact provider cleanup proof');
    await deleteOwnedAgentCheckpoints(
      f.owner.userId,
      f.owner.tenantId,
      [f.record.conversationId],
      cfg,
    );
    expect(await f.storage.acknowledgeCheckpointErasure(f.record, proof)).toBe(true);
    expect(await f.storage.acknowledgeExecutionRelease(f.record, proof)).toBe(true);
    expect(await f.storage.finishErasure(f.record)).toBe(true);
  });
  await deletion.cleanup();
  await deletion.acknowledge();
  expect(
    await mongoose.connection.db!.collection('agent_checkpoint_deletions').countDocuments(),
  ).toBe(0);
});

test('the checkpoint guard scopes current and legacy tenants, conversations and physical metadata', async () => {
  const f = await unresolvedResponse();
  const guard = createResponseCheckpointCleanupGuard(mongoose);
  expect(await guard(f.owner, [f.record.conversationId])).toBe(true);
  expect(await guard(f.owner, [])).toBe(false);
  expect(await guard(f.owner, ['unrelated-conversation'])).toBe(false);
  expect(await guard({ ...f.owner, userId: 'someone-else' })).toBe(false);
  expect(await guard({ ...f.owner, tenantId: 'someone-else' })).toBe(false);
  expect(await guard({ userId: f.owner.userId })).toBe(false);
  const legacy = await unresolvedResponse({ userId: f.owner.userId });
  expect(await guard(f.owner, [legacy.record.conversationId])).toBe(true);
  await tenantStorage.run(f.owner, async () => {
    expect(await guard(f.owner, [legacy.record.conversationId])).toBe(true);
    expect(await guard(f.owner, [f.record.conversationId])).toBe(true);
  });
  expect(await guard({ userId: f.owner.userId }, [legacy.record.conversationId])).toBe(true);
  // Generic cleanup also owns historical tenantless data for the same globally unique user.
  expect(
    await guard({ ...f.owner, tenantId: 'other-current-tenant' }, [legacy.record.conversationId]),
  ).toBe(true);
  const reads = jest.spyOn(mongoose.models.StoredResponse, 'exists');
  const ids = Array.from({ length: 201 }, (_, index) => `absent-${index}`);
  expect(await guard(f.owner, ids)).toBe(false);
  expect(reads).toHaveBeenCalledTimes(3);
  for (const result of reads.mock.results) {
    expect(result.value.getOptions().readPreference).toMatchObject({ mode: 'primary' });
    expect(result.value.projection()).toEqual({ _id: 1 });
  }
  reads.mockImplementationOnce(() => {
    throw new Error('database unavailable');
  });
  await expect(guard(f.owner)).rejects.toThrow('database unavailable');
});

test('guards an actual prepublication allocation before it has user or conversation payload fields', async () => {
  const owner = { userId: 'prepublication-owner', tenantId: 'prepublication-tenant' };
  const storage = createResponseStorage(mongoose);
  const guard = createResponseCheckpointCleanupGuard(mongoose);
  const conversationId = createManagedConversationId();
  const collection = mongoose.models.StoredResponse.collection;
  const updateOne = collection.updateOne.bind(collection);
  let checked = false;
  jest.spyOn(collection, 'updateOne').mockImplementation(async (...args) => {
    const result = await updateOne(...args);
    const update = args[1];
    if (!Array.isArray(update) && update.$set?.['_managed.ownerKey']) {
      checked = true;
      expect(await guard(owner, [conversationId])).toBe(true);
      expect(await guard(owner, ['different-conversation'])).toBe(false);
      expect(await guard({ ...owner, userId: 'different-owner' })).toBe(false);
      expect(await collection.findOne({ userId: owner.userId })).toBeNull();
    }
    return result;
  });
  const reserved = await tenantStorage.run(owner, () =>
    storage.reserve({
      ...owner,
      responseId: createManagedMessageId(),
      conversationId,
      agentId: 'agent',
      requestKey: randomUUID(),
      fingerprint: randomUUID(),
      requestJSON: '{}',
      parentMessageId: 'root',
    }),
  );
  expect(reserved.ok).toBe(true);
  expect(checked).toBe(true);
});

test('guards a specifically requested Root even before cascade identities have been remembered', async () => {
  const f = await unresolvedResponse();
  const deletion = await openCheckpointDeletion(
    f.owner.userId,
    f.owner.tenantId,
    f.record.conversationId,
    cfg,
  );
  expect(deletion.conversationIds()).toEqual([]);
  await expect(deletion.cleanup()).rejects.toMatchObject({ code: 'response_erasure_pending' });
  await expect(deletion.acknowledge()).rejects.toMatchObject({ code: 'response_erasure_pending' });
});
