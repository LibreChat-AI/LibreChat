import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { CheckpointIdentity, CheckpointRepository, SerializedCheckpoint } from './types';
import { createCheckpointDeletionJournal, checkpointDeletionTarget } from './journal';
import { checkpointOwnerNamespacePrefix } from './identity';
import { createMongoCheckpointRepository } from './mongo';
import { setupCheckpointIndexes } from './indexes';

let server: MongoMemoryServer;
let repository: CheckpointRepository;
let owner: string;
let key: CheckpointIdentity;
const payload = (id: string, parentCheckpointId?: string): SerializedCheckpoint => ({
  identity: { threadId: key.threadId, checkpointNs: key.checkpointNs, checkpointId: id },
  parentCheckpointId,
  checkpoint: { type: 'opaque', bytes: Uint8Array.from([0, 255, 42]) },
  metadata: { type: 'opaque', bytes: Uint8Array.from([255, 0]) },
  metadataSearch: { source: 'contract', step: 1 },
});
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(() => {
  owner = checkpointOwnerNamespacePrefix('owner', 'tenant');
  key = { threadId: 'child', checkpointNs: 'generation[1]', owner };
  repository = createMongoCheckpointRepository({
    checkpointCollectionName: 'cp',
    checkpointWritesCollectionName: 'writes',
    ttl: 3600,
  });
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

test('round-trips opaque bytes, explicit type tags and lineage with trusted root ownership', async () => {
  await repository.save(key, payload('002', '001'), { rootConversationId: 'root' });
  const stored = await repository.get(key);
  expect(stored).toEqual(payload('002', '001'));
  const row = await mongoose.connection.db!.collection('cp').findOne();
  expect(row).toMatchObject({
    thread_id: `${owner}child`,
    lc_owner: owner,
    lc_parent_thread: 'root',
    upserted_at: expect.any(Date),
  });
  expect(
    await repository.get({ ...key, owner: checkpointOwnerNamespacePrefix('foreign') }),
  ).toBeNull();
});

test('requires an exact historical proof and never falls back to the latest legacy head', async () => {
  await repository.save({ ...key, owner: undefined }, payload('001'), {});
  expect(await repository.get(key)).toBeNull();
  expect(
    await repository.get({ ...key, checkpointId: '001', legacyCheckpointId: 'other' }),
  ).toBeNull();
  expect(await repository.get({ ...key, checkpointId: '001', legacyCheckpointId: '001' })).toEqual(
    payload('001'),
  );
});

test('preserves legacy insert-only slots and replaces special writes with timestamps', async () => {
  const write = {
    taskId: 'task',
    index: 0,
    channel: 'value',
    value: { type: 'opaque', bytes: Uint8Array.of(1) },
  };
  await repository.saveWrites({ ...key, owner: undefined, checkpointId: '001' }, [write], {
    replace: false,
  });
  const owned = { ...key, checkpointId: '001', legacyCheckpointId: '001' };
  await repository.saveWrites(
    owned,
    [{ ...write, value: { type: 'opaque', bytes: Uint8Array.of(2) } }],
    { replace: false },
  );
  expect((await repository.readWrites(owned))[0].value.bytes).toEqual(Uint8Array.of(1));
  await repository.saveWrites(
    owned,
    [{ ...write, value: { type: 'opaque', bytes: Uint8Array.of(3) } }],
    { replace: true, rootConversationId: 'root' },
  );
  expect((await repository.readWrites(owned))[0].value.bytes).toEqual(Uint8Array.of(3));
  const row = await mongoose.connection.db!.collection('writes').findOne({ lc_owner: owner });
  expect(row).toMatchObject({ upserted_at: expect.any(Date), lc_parent_thread: 'root' });
});

test('generation deletion escapes metacharacters and keeps replacement generations', async () => {
  const legacy = { ...key, owner: undefined };
  await repository.save(legacy, payload('001'), {});
  await repository.save({ ...legacy, checkpointNs: 'generation1' }, payload('002'), {});
  await repository.save({ ...legacy, checkpointNs: 'generation[1]|nested' }, payload('003'), {});
  await repository.deleteGeneration('child', undefined, 'generation[1]');
  const rows = await mongoose.connection.db!.collection('cp').find().toArray();
  expect(rows.map((row) => row.checkpoint_id)).toEqual(['002']);
});

test('rejects ambiguous empty namespaces before deleting either checkpoints or pending writes', async () => {
  const checkpoints = mongoose.connection.db!.collection('cp');
  const writes = mongoose.connection.db!.collection('writes');
  const rows = [
    { thread_id: 'child', checkpoint_ns: '', checkpoint_id: '001' },
    { thread_id: 'child', checkpoint_ns: 'nested|child', checkpoint_id: '002' },
    { thread_id: 'child', checkpoint_ns: 'lcg:v2:new-generation', checkpoint_id: '003' },
  ];
  await checkpoints.insertMany(rows);
  await writes.insertMany(rows.map((row) => ({ ...row, task_id: 'pending', idx: 0 })));
  await expect(repository.deleteGeneration('child', undefined, '')).rejects.toThrow(
    'captured checkpoint generation',
  );
  await expect(
    repository.deleteGeneration('child', {
      threadId: 'child',
      checkpointIds: ['001', '002'],
      checkpointNamespace: '',
    }),
  ).rejects.toThrow('captured checkpoint generation');
  expect(await checkpoints.countDocuments()).toBe(3);
  expect(await writes.countDocuments()).toBe(3);
  await repository.deleteGeneration('child', { threadId: 'child', checkpointIds: ['001', '002'] });
  expect((await checkpoints.find().toArray()).map((row) => row.checkpoint_id)).toEqual(['003']);
  expect((await writes.find().toArray()).map((row) => row.checkpoint_id)).toEqual(['003']);
});

test('a captured legacy generation takes precedence over optional namespace hints', async () => {
  await repository.save({ ...key, owner: undefined }, payload('001'), {});
  await repository.deleteGeneration('child', { threadId: 'child', checkpointIds: ['001'] }, '');
  expect(await repository.get({ ...key, owner: undefined })).toBeNull();
});

test('owner cleanup includes orphan writes by root but preserves other tenants', async () => {
  const write = {
    taskId: 'task',
    index: 0,
    channel: 'value',
    value: { type: 'opaque', bytes: Uint8Array.of(1) },
  };
  await repository.saveWrites({ ...key, checkpointId: '001' }, [write], {
    replace: false,
    rootConversationId: 'root',
  });
  const foreign = checkpointOwnerNamespacePrefix('owner', 'another-tenant');
  await repository.saveWrites({ ...key, owner: foreign, checkpointId: '002' }, [write], {
    replace: false,
    rootConversationId: 'root',
  });
  await repository.deleteOwned('owner', 'tenant', ['root']);
  expect(
    (await mongoose.connection.db!.collection('writes').find().toArray()).map(
      (row) => row.lc_owner,
    ),
  ).toEqual([foreign]);
});

test('journal acknowledgement keeps a concurrently refreshed receipt and wire-compatible keys', async () => {
  const journal = createCheckpointDeletionJournal();
  const scope = { userId: 'owner', tenantId: 'tenant', rootConversationId: 'root' };
  const store = {
    type: 'mongo' as const,
    ttlSeconds: 3600,
    checkpointCollectionName: 'cp',
    checkpointWritesCollectionName: 'writes',
  };
  const first = checkpointDeletionTarget(
    scope,
    store,
    'child',
    'first',
    payload('001').identity,
    'owned',
  );
  await journal.remember([first]);
  await journal.remember([{ ...first, version: 'newer' }]);
  await journal.acknowledge([first]);
  expect(await journal.retained('owner', 'tenant', 'root')).toEqual([
    { ...first, version: 'newer' },
  ]);
  expect(await journal.retained('foreign', 'tenant', 'root')).toEqual([]);
  expect(await journal.hasPending('owner', 'tenant', 'root')).toBe(true);
  expect(await journal.reclaim(first)).toBe(0);
  expect(await journal.reclaim({ ...first, version: 'newer' })).toBe(1);
});

test.each(['conversations', 'messages', 'toolcalls', 'sharedlinks'])(
  'retains deletion evidence while %s persistence exists',
  async (name) => {
    const journal = createCheckpointDeletionJournal();
    const target = checkpointDeletionTarget(
      { userId: 'owner' },
      {
        type: 'memory',
        ttlSeconds: 3600,
        checkpointCollectionName: 'cp',
        checkpointWritesCollectionName: 'writes',
      },
      'root',
      'version',
    );
    expect(await journal.hasPersistence(target)).toBe(false);
    await mongoose.connection
      .db!.collection(name)
      .insertOne({ user: 'owner', conversationId: 'root' });
    expect(await journal.hasPersistence(target)).toBe(true);
  },
);

test('retries checkpoint index conflicts through the batch deadline and creates TTL indexes', async () => {
  const conflict = new mongoose.mongo.MongoServerError({
    code: 40333,
    message: 'index build in progress',
  });
  const createIndex = mongoose.mongo.Collection.prototype.createIndex;
  const builds = new Map<string, number>();
  jest.spyOn(mongoose.mongo.Collection.prototype, 'createIndex').mockImplementation(function (
    this: mongoose.mongo.Collection,
    ...args: Parameters<typeof createIndex>
  ) {
    const count = (builds.get(this.collectionName) ?? 0) + 1;
    builds.set(this.collectionName, count);
    if (count === 1) return Promise.reject(conflict);
    return createIndex.apply(this, args);
  });

  expect(
    await setupCheckpointIndexes(repository, { peerBuildPollMs: 1, peerBuildDeadlineMs: 200 }),
  ).toEqual([]);
  expect([...builds]).toEqual([
    ['cp', 4],
    ['writes', 4],
  ]);
  for (const name of ['cp', 'writes']) {
    expect(await mongoose.connection.db!.collection(name).indexes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { upserted_at: 1 }, expireAfterSeconds: 3600 }),
      ]),
    );
  }
});

test('reports every nonretryable index error without retrying individual builds', async () => {
  const failure = new Error('index permission denied');
  const createIndex = mongoose.mongo.Collection.prototype.createIndex;
  let builds = 0;
  jest.spyOn(mongoose.mongo.Collection.prototype, 'createIndex').mockImplementation(function (
    this: mongoose.mongo.Collection,
    ...args: Parameters<typeof createIndex>
  ) {
    if (this.collectionName === 'cp') {
      builds++;
      return Promise.reject(failure);
    }
    return createIndex.apply(this, args);
  });
  expect(await setupCheckpointIndexes(repository)).toEqual([failure, failure]);
  expect(builds).toBe(2);
});
