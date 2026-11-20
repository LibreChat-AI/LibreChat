import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { CreateIndexesOptions } from 'mongodb';
import type { Model, Mongoose } from 'mongoose';
import type { IAgentTriggerDeliveryDocument } from '~/types/triggerDelivery';
import triggerDeliverySchema, { BACKGROUND_POLL_INDEX } from '~/schema/triggerDelivery';
import { createAgentTriggerDeliveryModel } from './triggerDelivery';
import { createIndexesWithRetry } from '~/utils/retry';

const POLLING_KEYS = {
  user: 1,
  'envelope.event.source.type': 1,
  'envelope.event.source.id': 1,
  'envelope.target.conversationId': 1,
  requiredWorkerCapability: 1,
  status: 1,
  updatedAt: -1,
  _id: -1,
} as const;
const LEGACY_NAME = Object.entries(POLLING_KEYS)
  .map(([key, direction]) => `${key}_${direction}`)
  .join('_');

let server: MongoMemoryServer;
let database: Mongoose;
let counter = 0;

async function connect(autoIndex = false, autoCreate = true, dbName = `polling_${++counter}`) {
  database = new mongoose.Mongoose();
  await database.connect(server.getUri(), { dbName, autoIndex, autoCreate });
  return database.connection.collection('agenttriggerdeliveries');
}

function enforceCosmosNameLimit(model: Model<IAgentTriggerDeliveryDocument>) {
  const createIndex = model.collection.createIndex.bind(model.collection);
  return jest.spyOn(model.collection, 'createIndex').mockImplementation(async (keys, options) => {
    const name =
      options?.name ??
      Object.entries(keys)
        .map(([key, direction]) => `${key}_${direction}`)
        .join('_');
    if (name.length > 128) {
      throw new mongoose.mongo.MongoServerError({
        ok: 0,
        code: 67,
        errmsg: 'Index name is too long (128 char max)',
      });
    }
    return createIndex(keys, options);
  });
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
}, 60_000);

afterEach(async () => {
  await database?.disconnect();
});

afterAll(async () => {
  await server?.stop();
});

test('keeps the polling key order and uses a short explicit name', () => {
  expect(triggerDeliverySchema.indexes()).toContainEqual([
    POLLING_KEYS,
    expect.objectContaining({ name: BACKGROUND_POLL_INDEX }),
  ]);
  expect(BACKGROUND_POLL_INDEX.length).toBeLessThanOrEqual(128);
  expect(LEGACY_NAME).toHaveLength(151);
});

test.each([true, false])(
  'starts a fresh Cosmos-like database with autoIndex=%s',
  async (autoIndex) => {
    await connect(autoIndex, false);
    const model = createAgentTriggerDeliveryModel(database);
    const createIndex = enforceCosmosNameLimit(model);

    await model.init();
    await createIndexesWithRetry(model);

    const indexes = await model.collection.listIndexes().toArray();
    expect(indexes).toHaveLength(triggerDeliverySchema.indexes().length + 1);
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: POLLING_KEYS, name: BACKGROUND_POLL_INDEX }),
    );
    expect(createIndex).toHaveBeenCalled();
  },
);

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  'preserves the legacy index with autoIndex=%s and autoCreate=%s',
  async (autoIndex, autoCreate) => {
    const collection = await connect(autoIndex, autoCreate);
    await collection.createIndex(POLLING_KEYS, { name: LEGACY_NAME });
    const [before] = (await collection.listIndexes().toArray()).filter(
      (i) => i.name === LEGACY_NAME,
    );
    const model = createAgentTriggerDeliveryModel(database);
    const dropIndex = jest.spyOn(model.collection, 'dropIndex');
    const dropIndexes = jest.spyOn(model.collection, 'dropIndexes');

    await expect(model.init()).resolves.toBeUndefined();
    await createIndexesWithRetry(model);
    await createIndexesWithRetry(model);

    const indexes = await collection.listIndexes().toArray();
    expect(indexes).toHaveLength(triggerDeliverySchema.indexes().length + 1);
    expect(indexes.find((i) => i.name === LEGACY_NAME)).toEqual(before);
    expect(indexes.some((i) => i.name === BACKGROUND_POLL_INDEX)).toBe(false);
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { deliveryKey: 1 }, unique: true }),
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    );
    expect(dropIndex).not.toHaveBeenCalled();
    expect(dropIndexes).not.toHaveBeenCalled();
    expect(model.schema.indexes()).toContainEqual([
      POLLING_KEYS,
      expect.objectContaining({ name: BACKGROUND_POLL_INDEX }),
    ]);
  },
);

test.each([true, false])(
  'preserves the legacy index with collection-default collation and autoIndex=%s',
  async (autoIndex) => {
    const collection = await connect(autoIndex);
    await database.connection.createCollection(collection.name, {
      collation: { locale: 'en', strength: 2, numericOrdering: true },
    });
    await collection.createIndex(POLLING_KEYS, { name: LEGACY_NAME });
    const before = (await collection.listIndexes().toArray()).find(
      (index) => index.name === LEGACY_NAME,
    );
    const model = createAgentTriggerDeliveryModel(database);

    await expect(model.init()).resolves.toBeUndefined();
    await createIndexesWithRetry(model);
    await createIndexesWithRetry(model);

    const indexes = await model.listIndexes();
    expect(indexes.find((index) => index.name === LEGACY_NAME)).toEqual(before);
    expect(indexes.some((index) => index.name === BACKGROUND_POLL_INDEX)).toBe(false);
    expect(indexes).toHaveLength(triggerDeliverySchema.indexes().length + 1);
  },
);

test('does not reuse a simple-collation override on a collated collection', async () => {
  const collection = await connect();
  await database.connection.createCollection(collection.name, { collation: { locale: 'en' } });
  await collection.createIndex(POLLING_KEYS, {
    name: LEGACY_NAME,
    collation: { locale: 'simple' },
  });
  const model = createAgentTriggerDeliveryModel(database);

  await createIndexesWithRetry(model);

  const indexes = await model.listIndexes();
  expect(indexes).toContainEqual(
    expect.objectContaining({
      name: BACKGROUND_POLL_INDEX,
      collation: expect.objectContaining({ locale: 'en' }),
    }),
  );
  expect(indexes).toContainEqual(expect.objectContaining({ name: LEGACY_NAME }));
});

test('does not reuse an index-level collation override on a simple collection', async () => {
  const collection = await connect();
  await collection.createIndex(POLLING_KEYS, { name: LEGACY_NAME, collation: { locale: 'en' } });
  const model = createAgentTriggerDeliveryModel(database);

  await createIndexesWithRetry(model);

  const indexes = await model.listIndexes();
  expect(indexes.find((index) => index.name === BACKGROUND_POLL_INDEX)?.collation).toBeUndefined();
  expect(indexes).toContainEqual(expect.objectContaining({ name: LEGACY_NAME }));
});

test('reuses a custom short name without submitting the legacy name to Cosmos', async () => {
  const collection = await connect(true);
  await collection.createIndex(POLLING_KEYS, { name: 'custom_background_poll' });
  const model = createAgentTriggerDeliveryModel(database);
  enforceCosmosNameLimit(model);

  await model.init();
  await createIndexesWithRetry(model);

  expect(await collection.listIndexes().toArray()).toContainEqual(
    expect.objectContaining({ name: 'custom_background_poll', key: POLLING_KEYS }),
  );
});

test('restarts against the same short-named index', async () => {
  const dbName = `polling_restart_${++counter}`;
  await connect(true, true, dbName);
  const first = createAgentTriggerDeliveryModel(database);
  await createIndexesWithRetry(first);
  const before = await first.collection.listIndexes().toArray();
  await database.disconnect();
  await connect(true, true, dbName);
  const second = createAgentTriggerDeliveryModel(database);

  await second.init();
  await createIndexesWithRetry(second);

  expect(await second.collection.listIndexes().toArray()).toEqual(before);
  expect(createAgentTriggerDeliveryModel(database)).toBe(second);
});

test('still rejects an existing short name with different keys', async () => {
  const collection = await connect();
  await collection.createIndex({ unrelated: 1 }, { name: BACKGROUND_POLL_INDEX });
  const model = createAgentTriggerDeliveryModel(database);

  await expect(createIndexesWithRetry(model)).rejects.toMatchObject({ code: 86 });
});

test.each<[string, CreateIndexesOptions]>([
  ['unique', { unique: true }],
  ['sparse', { sparse: true }],
  ['partial', { partialFilterExpression: { user: { $exists: true } } }],
  ['collated', { collation: { locale: 'en' } }],
])('still rejects an incompatible %s index with the short name', async (_kind, options) => {
  const collection = await connect();
  await collection.createIndex(POLLING_KEYS, { ...options, name: BACKGROUND_POLL_INDEX });
  const model = createAgentTriggerDeliveryModel(database);

  await expect(createIndexesWithRetry(model)).rejects.toMatchObject({ code: 86 });
});

test('does not reuse a hidden legacy index', async () => {
  const collection = await connect();
  await collection.createIndex(POLLING_KEYS, { name: LEGACY_NAME, hidden: true });
  const model = createAgentTriggerDeliveryModel(database);

  await expect(createIndexesWithRetry(model)).rejects.toMatchObject({ code: 85 });
});

test('retries every required index after a partially failed build', async () => {
  await connect();
  const model = createAgentTriggerDeliveryModel(database);
  await model.init();
  const createIndex = model.collection.createIndex.bind(model.collection);
  let remainingFailures = 6;
  jest.spyOn(model.collection, 'createIndex').mockImplementation(async (keys, options) => {
    if (remainingFailures-- > 0) {
      throw new Error('ECONNRESET');
    }
    return createIndex(keys, options);
  });

  await createIndexesWithRetry(model);

  expect(await model.listIndexes()).toHaveLength(triggerDeliverySchema.indexes().length + 1);
});

test('preserves the caller’s deadline while a peer is building indexes', async () => {
  await connect();
  const model = createAgentTriggerDeliveryModel(database);
  await model.init();
  jest.spyOn(model.collection, 'createIndex').mockRejectedValue(
    new mongoose.mongo.MongoServerError({
      ok: 0,
      code: 40333,
      errmsg: 'Existing index build in progress on the same collection.',
    }),
  );

  await expect(
    createIndexesWithRetry(model, { maxAttempts: 1, peerBuildDeadlineMs: 0 }),
  ).rejects.toMatchObject({ code: 40333 });
});

test('respects an explicitly empty index subset', async () => {
  await connect();
  const model = createAgentTriggerDeliveryModel(database);
  await model.init();
  const createIndex = jest.spyOn(model.collection, 'createIndex');
  const options = { toCreate: [], maxTimeMS: 1_000 };

  await model.createIndexes(options);

  expect(createIndex).not.toHaveBeenCalled();
});

test('propagates collection metadata failures instead of assuming simple collation', async () => {
  await connect();
  const model = createAgentTriggerDeliveryModel(database);
  await model.init();
  const error = new mongoose.mongo.MongoServerError({ ok: 0, code: 13, errmsg: 'Unauthorized' });
  jest.spyOn(database.connection.db!, 'listCollections').mockImplementation(() => {
    throw error;
  });

  await expect(createIndexesWithRetry(model)).rejects.toBe(error);
});

test('propagates index-list failures instead of treating the collection as missing', async () => {
  await connect();
  const model = createAgentTriggerDeliveryModel(database);
  await model.init();
  const error = new mongoose.mongo.MongoServerError({ ok: 0, code: 13, errmsg: 'Unauthorized' });
  jest.spyOn(model.collection, 'listIndexes').mockImplementation(() => {
    throw error;
  });

  await expect(createIndexesWithRetry(model)).rejects.toBe(error);
});
