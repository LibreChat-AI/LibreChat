import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { LeaseHarness } from '~/contracts/lease';
import { createResourceLockModel } from '~/models/resourceLock';
import { describeLeaseConformance } from '~/contracts/lease';
import { createResourceLockMethods } from './resourceLock';

const instances = Array.from({ length: 3 }, () => new mongoose.Mongoose());
const models = instances.map((instance) => {
  instance.set('autoIndex', false);
  instance.set('autoCreate', false);
  return createResourceLockModel(instance);
});
let server: MongoMemoryServer;

const harness: LeaseHarness = {
  name: 'mongoose',
  async setup() {
    server = await MongoMemoryServer.create();
    await Promise.all(instances.map((instance) => instance.connect(server.getUri())));
    await models[0].createIndexes();
    return [
      createResourceLockMethods(instances[0]),
      createResourceLockMethods(instances[1]),
      createResourceLockMethods(instances[2]),
    ];
  },
  async teardown() {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await Promise.all(instances.map((instance) => instance.disconnect()));
    await server?.stop();
  },
  async reset() {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await models[0].deleteMany({});
  },
  setTime(now) {
    // Freeze Date only. Mongo's network, readiness deadlines, and cleanup timers stay real.
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
    jest.setSystemTime(now);
  },
  async seed(record) {
    await models[0].create(record);
  },
  async read(key) {
    const record = await models[0].findOne({ key }).lean();
    return record
      ? { key: record.key, ownerId: record.ownerId, expiresAt: record.expiresAt }
      : null;
  },
  failNext(operation, error) {
    const method = {
      acquire: 'insertOne',
      renew: 'findOneAndUpdate',
      release: 'deleteOne',
    } as const;
    jest.spyOn(models[0].collection, method[operation]).mockImplementationOnce(() => {
      throw error;
    });
  },
};

describeLeaseConformance(harness);

describe('resource lease Mongo adapter', () => {
  beforeAll(() => harness.setup());
  afterAll(() => harness.teardown());
  beforeEach(() => harness.reset());

  it('enforces unique keys and retains TTL cleanup configuration', async () => {
    const record = { key: 'unique', ownerId: 'a', expiresAt: new Date('2100-01-01') };
    await models[0].create(record);
    await expect(models[1].create({ ...record, ownerId: 'b' })).rejects.toMatchObject({
      code: 11000,
    });
    expect(await models[0].listIndexes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { key: 1 }, unique: true }),
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('propagates an expired-takeover driver failure without replacing the owner', async () => {
    const methods = createResourceLockMethods(instances[0]);
    const record = { key: 'takeover', ownerId: 'a', expiresAt: new Date('2100-01-01') };
    await harness.seed(record);
    harness.setTime(record.expiresAt);
    const failure = new Error('takeover unavailable');
    jest.spyOn(models[0].collection, 'findOneAndUpdate').mockRejectedValueOnce(failure);
    await expect(
      methods.acquireResourceLock({ key: record.key, ownerId: 'b', ttlMs: 30_000 }),
    ).rejects.toBe(failure);
    expect(await harness.read(record.key)).toEqual(record);
  });

  it('does not claim ownership when an insert commits but its acknowledgement is lost', async () => {
    const methods = createResourceLockMethods(instances[0]);
    const insert = models[0].collection.insertOne.bind(models[0].collection);
    const failure = new mongoose.mongo.MongoNetworkError('lost acknowledgement');
    jest.spyOn(models[0].collection, 'insertOne').mockImplementationOnce(async (...args) => {
      await insert(...args);
      throw failure;
    });
    const lock = { key: 'unacknowledged', ownerId: 'a', ttlMs: 30_000 };
    await expect(methods.acquireResourceLock(lock)).rejects.toBe(failure);
    expect((await harness.read(lock.key))?.ownerId).toBe('a');
    expect(
      await createResourceLockMethods(instances[1]).acquireResourceLock({ ...lock, ownerId: 'b' }),
    ).toBe(false);
  });

  it('retries initialization after failure and shares successful readiness within a factory', async () => {
    const methods = createResourceLockMethods(instances[0]);
    const failure = new Error('index permission denied');
    const build = jest.spyOn(models[0], 'createIndexes').mockRejectedValueOnce(failure);
    const lock = { key: 'ready', ownerId: 'a', ttlMs: 30_000 };
    await expect(methods.acquireResourceLock(lock)).rejects.toBe(failure);
    expect(await harness.read(lock.key)).toBeNull();
    expect(await methods.acquireResourceLock(lock)).toBe(true);
    expect(await methods.acquireResourceLock({ ...lock, key: 'other' })).toBe(true);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('returns false at the readiness deadline without writing, then can acquire after readiness', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    jest.spyOn(models[0], 'createIndexes').mockReturnValueOnce(gate);
    const methods = createResourceLockMethods(instances[0]);
    const lock = { key: 'deadline', ownerId: 'a', ttlMs: 30_000, readyWaitMs: 25 };
    const attempt = methods.acquireResourceLock(lock);
    try {
      await jest.advanceTimersByTimeAsync(24);
      let settled = false;
      void attempt.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await attempt).toBe(false);
    } finally {
      finish();
      jest.useRealTimers();
    }
    expect(await harness.read(lock.key)).toBeNull();
    expect(await methods.acquireResourceLock(lock)).toBe(true);
  });

  it('caps the readiness wait at two seconds even when the caller asks for longer', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    jest.spyOn(models[0], 'createIndexes').mockReturnValueOnce(gate);
    const methods = createResourceLockMethods(instances[0]);
    const lock = { key: 'bounded', ownerId: 'a', ttlMs: 30_000, readyWaitMs: 60_000 };
    try {
      const attempt = methods.acquireResourceLock(lock);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(await attempt).toBe(false);
    } finally {
      finish();
      jest.useRealTimers();
    }
    expect(await harness.read(lock.key)).toBeNull();
  });
});
