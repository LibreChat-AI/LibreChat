import mongoose from 'mongoose';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { getTransactionSupport, supportsTransactions } from './transactions';

jest.mock('~/config/winston', () => ({ debug: jest.fn() }));

describe('getTransactionSupport', () => {
  // The cache-hit path does not touch the database, so a stub mongoose is fine.
  const mongoose = {} as unknown as typeof import('mongoose');

  it('returns the cached value on a cache hit (does not re-probe)', async () => {
    await expect(getTransactionSupport(mongoose, true)).resolves.toBe(true);
    await expect(getTransactionSupport(mongoose, false)).resolves.toBe(false);
  });
});

describe('transaction capability against real MongoDB', () => {
  const standalone = new mongoose.Mongoose();
  const replica = new mongoose.Mongoose();
  let mongo: MongoMemoryServer;
  let repl: MongoMemoryReplSet;

  beforeAll(async () => {
    [mongo, repl] = await Promise.all([
      MongoMemoryServer.create(),
      MongoMemoryReplSet.create({ replSet: { count: 1 } }),
    ]);
    await Promise.all([
      standalone.connect(mongo.getUri()),
      replica.connect(repl.getUri(), { readPreference: 'secondaryPreferred' }),
    ]);
  }, 60000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await Promise.all([standalone.disconnect(), replica.disconnect()]);
    await Promise.all([mongo?.stop(), repl?.stop()]);
  });

  it('returns false for standalone MongoDB without writing probe data', async () => {
    await expect(supportsTransactions(standalone)).resolves.toBe(false);
    expect(
      await standalone.connection.db!.collection('__transaction_test__').countDocuments(),
    ).toBe(0);
  });

  it('supports transactions despite a secondaryPreferred client default', async () => {
    await expect(supportsTransactions(replica)).resolves.toBe(true);
  });

  it('shares an inflight probe only within the same connection', async () => {
    const replicaSessions = jest.spyOn(replica, 'startSession');
    const standaloneSessions = jest.spyOn(standalone, 'startSession');
    await expect(
      Promise.all([
        getTransactionSupport(replica, null),
        getTransactionSupport(replica, null),
        getTransactionSupport(standalone, null),
      ]),
    ).resolves.toEqual([true, true, false]);
    expect(replicaSessions).toHaveBeenCalledTimes(1);
    expect(standaloneSessions).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed shared probe and retries after recovery', async () => {
    const failure = new mongoose.mongo.MongoNetworkError('probe connection lost');
    const sessions = jest.spyOn(replica, 'startSession').mockRejectedValueOnce(failure);
    const results = await Promise.allSettled([
      getTransactionSupport(replica, null),
      getTransactionSupport(replica, null),
    ]);
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(sessions).toHaveBeenCalledTimes(1);
    await expect(getTransactionSupport(replica, null)).resolves.toBe(true);
    expect(sessions).toHaveBeenCalledTimes(2);
  });

  it.each([
    [59, "no such command: 'commitTransaction'", false],
    [59, "no such command: 'find'", true],
    [20, 'an unrelated illegal operation', true],
    [13, 'not authorized', true],
    [18, 'authentication failed', true],
  ])(
    'classifies commit failure %i (%s) without hiding operational errors',
    async (code, errmsg, throws) => {
      const session = await replica.startSession();
      jest.spyOn(replica, 'startSession').mockResolvedValueOnce(session);
      const end = jest.spyOn(session, 'endSession');
      const error = new mongoose.mongo.MongoServerError({ code, errmsg });
      jest.spyOn(session, 'commitTransaction').mockRejectedValueOnce(error);
      if (throws) await expect(supportsTransactions(replica)).rejects.toBe(error);
      else await expect(supportsTransactions(replica)).resolves.toBe(false);
      expect(end).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a missing DocumentDB probe namespace after concurrent initialization', async () => {
    const session = await replica.startSession();
    const starts = jest.spyOn(replica, 'startSession').mockResolvedValueOnce(session);
    jest.spyOn(session, 'commitTransaction').mockRejectedValueOnce(
      new mongoose.mongo.MongoServerError({
        code: 263,
        errmsg: 'non-existent collection in transaction',
      }),
    );
    const create = jest
      .spyOn(replica.connection.db!, 'createCollection')
      .mockRejectedValueOnce(
        new mongoose.mongo.MongoServerError({ code: 48, errmsg: 'namespace already exists' }),
      );
    await expect(supportsTransactions(replica)).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith('__transaction_test__');
    expect(starts).toHaveBeenCalledTimes(2);
  });

  it('does not hide operational failure while creating the probe namespace', async () => {
    const session = await replica.startSession();
    jest.spyOn(replica, 'startSession').mockResolvedValueOnce(session);
    jest.spyOn(session, 'commitTransaction').mockRejectedValueOnce(
      new mongoose.mongo.MongoServerError({
        code: 263,
        errmsg: 'non-existent collection in transaction',
      }),
    );
    const error = new mongoose.mongo.MongoServerError({ code: 13, errmsg: 'not authorized' });
    jest.spyOn(replica.connection.db!, 'createCollection').mockRejectedValueOnce(error);
    await expect(supportsTransactions(replica)).rejects.toBe(error);
  });
});
