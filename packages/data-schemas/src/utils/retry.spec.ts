import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Model } from 'mongoose';
import type { IAgentTriggerDeliveryDocument } from '~/types/triggerDelivery';
import { buildIndexWithRetry, createIndexesWithRetry, retryWithBackoff } from './retry';
import triggerDeliverySchema from '~/schema/triggerDelivery';

const DB_SETUP_TIMEOUT_MS = 60_000;
/** Amazon DocumentDB: "Existing index build in progress on the same collection." */
const INDEX_BUILD_ALREADY_IN_PROGRESS = 40333;
const BUILD_LATENCY_MS = 5;

let mongoServer: MongoMemoryServer;
let modelCounter = 0;

function indexBuildInProgressError(): Error {
  return new mongoose.mongo.MongoServerError({
    ok: 0,
    code: INDEX_BUILD_ALREADY_IN_PROGRESS,
    errmsg:
      'Existing index build in progress on the same collection. Collection is limited to a single index build at a time.',
  });
}

/**
 * Turns the in-memory MongoDB into a single-index-build engine: a createIndex that
 * arrives while another build on the same collection is in flight is rejected the
 * way DocumentDB rejects it, instead of being serialized the way MongoDB does.
 */
function enforceSingleIndexBuild(model: Model<IAgentTriggerDeliveryDocument>): {
  rejected: () => number;
} {
  const collection = model.collection;
  const createIndex = collection.createIndex.bind(collection);
  let inFlight = 0;
  let rejected = 0;
  collection.createIndex = async (fields, options) => {
    if (inFlight > 0) {
      rejected += 1;
      throw indexBuildInProgressError();
    }
    inFlight += 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, BUILD_LATENCY_MS));
      return await createIndex(fields, options);
    } finally {
      inFlight -= 1;
    }
  };
  return { rejected: () => rejected };
}

function compileDeliveryModel(): Model<IAgentTriggerDeliveryDocument> {
  modelCounter += 1;
  return mongoose.model<IAgentTriggerDeliveryDocument>(
    `RetrySpecDelivery${modelCounter}`,
    triggerDeliverySchema,
    `retry_spec_deliveries_${modelCounter}`,
  );
}

async function indexNames(model: Model<IAgentTriggerDeliveryDocument>): Promise<Set<string>> {
  const indexes = await model.listIndexes();
  return new Set(indexes.map((index) => index.name));
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, DB_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
}, DB_SETUP_TIMEOUT_MS);

describe('createIndexesWithRetry on a single-index-build engine', () => {
  test('waits for the automatic build Mongoose starts at compile before building explicitly', async () => {
    const model = compileDeliveryModel();
    const automaticBuildStarted = new Promise<void>((resolve) => {
      model.once('index-single-start', () => resolve());
    });
    const engine = enforceSingleIndexBuild(model);
    await automaticBuildStarted;

    await createIndexesWithRetry(model, { baseDelayMs: 1, jitter: false });

    await expect(model.init()).resolves.toBeUndefined();
    const names = await indexNames(model);
    expect(names.size).toBe(triggerDeliverySchema.indexes().length + 1);
    expect(names.has('deliveryKey_1')).toBe(true);
    expect(engine.rejected()).toBe(0);
  });

  test('keeps polling while another replica holds the collection, then builds', async () => {
    const model = compileDeliveryModel();
    await model.init();
    const collection = model.collection;
    const createIndex = collection.createIndex.bind(collection);
    let remainingRejections = 6;
    let attempts = 0;
    collection.createIndex = async (fields, options) => {
      attempts += 1;
      if (remainingRejections > 0) {
        remainingRejections -= 1;
        throw indexBuildInProgressError();
      }
      return createIndex(fields, options);
    };

    await createIndexesWithRetry(model, { maxAttempts: 1, peerBuildPollMs: 1 });

    expect(remainingRejections).toBe(0);
    expect(attempts).toBeGreaterThan(6);
    expect((await indexNames(model)).has('deliveryKey_1')).toBe(true);
  });

  test('surfaces the conflict once the peer-build deadline passes', async () => {
    const model = compileDeliveryModel();
    await model.init();
    let attempts = 0;
    model.collection.createIndex = async () => {
      attempts += 1;
      throw indexBuildInProgressError();
    };

    await expect(
      createIndexesWithRetry(model, {
        maxAttempts: 1,
        peerBuildPollMs: 1,
        peerBuildDeadlineMs: 20,
      }),
    ).rejects.toMatchObject({ code: INDEX_BUILD_ALREADY_IN_PROGRESS });
    expect(attempts).toBeGreaterThan(triggerDeliverySchema.indexes().length);
  });

  test('still fails fast on errors that are not transient', async () => {
    const model = compileDeliveryModel();
    await model.init();
    const collection = model.collection;
    let attempts = 0;
    collection.createIndex = async () => {
      attempts += 1;
      throw new mongoose.mongo.MongoServerError({
        ok: 0,
        code: 67,
        errmsg: 'CannotCreateIndex: bad index spec',
      });
    };

    await expect(createIndexesWithRetry(model, { baseDelayMs: 1, jitter: false })).rejects.toThrow(
      'bad index spec',
    );
    expect(attempts).toBe(triggerDeliverySchema.indexes().length);
  });
});

describe('buildIndexWithRetry on a raw driver collection', () => {
  function rawCollection() {
    modelCounter += 1;
    return mongoose.connection.db!.collection(`retry_spec_raw_${modelCounter}`);
  }

  test('keeps polling while another replica holds the collection, then builds', async () => {
    const collection = rawCollection();
    const createIndex = collection.createIndex.bind(collection);
    let remainingRejections = 3;
    let attempts = 0;
    collection.createIndex = async (fields, options) => {
      attempts += 1;
      if (remainingRejections > 0) {
        remainingRejections -= 1;
        throw indexBuildInProgressError();
      }
      return createIndex(fields, options);
    };

    await expect(
      buildIndexWithRetry(() => collection.createIndex({ key: 1 }, { name: 'key_1' }), 'key_1', {
        maxAttempts: 1,
        peerBuildPollMs: 1,
      }),
    ).resolves.toBe('key_1');
    expect(attempts).toBe(4);
    expect((await collection.indexes()).map((index) => index.name)).toContain('key_1');
  });

  test('surfaces the conflict once the peer-build deadline passes', async () => {
    const collection = rawCollection();
    let attempts = 0;
    collection.createIndex = async () => {
      attempts += 1;
      throw indexBuildInProgressError();
    };

    await expect(
      buildIndexWithRetry(() => collection.createIndex({ key: 1 }), 'key_1', {
        maxAttempts: 1,
        peerBuildPollMs: 1,
        peerBuildDeadlineMs: 20,
      }),
    ).rejects.toMatchObject({ code: INDEX_BUILD_ALREADY_IN_PROGRESS });
    expect(attempts).toBeGreaterThan(1);
  });

  test('still fails fast on errors that are not transient', async () => {
    const collection = rawCollection();
    let attempts = 0;
    collection.createIndex = async () => {
      attempts += 1;
      throw new mongoose.mongo.MongoServerError({
        ok: 0,
        code: 67,
        errmsg: 'CannotCreateIndex: bad index spec',
      });
    };

    await expect(
      buildIndexWithRetry(() => collection.createIndex({ key: 1 }), 'key_1', {
        baseDelayMs: 1,
        jitter: false,
      }),
    ).rejects.toThrow('bad index spec');
    expect(attempts).toBe(1);
  });
});

describe('retryWithBackoff option validation', () => {
  test.each([
    ['a NaN attempt count', { maxAttempts: NaN }],
    ['a NaN base delay', { baseDelayMs: NaN }],
    ['a NaN maximum delay', { maxDelayMs: NaN }],
  ])('rejects %s before running the operation', async (_shape, options) => {
    let attempts = 0;
    const operation = async () => {
      attempts += 1;
    };

    await expect(retryWithBackoff(operation, 'validation', options)).rejects.toThrow(
      'Invalid options',
    );
    expect(attempts).toBe(0);
  });
});

describe('buildIndexWithRetry peer-build deadline', () => {
  test('reruns after a long admitted build reports a companion conflict', async () => {
    let attempts = 0;
    const build = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw indexBuildInProgressError();
      }
      return 'built';
    };

    await expect(
      buildIndexWithRetry(build, 'long-build', {
        maxAttempts: 1,
        peerBuildPollMs: 1,
        peerBuildDeadlineMs: 20,
      }),
    ).resolves.toBe('built');
    expect(attempts).toBe(2);
  });
});
