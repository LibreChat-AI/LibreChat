import mongoose from 'mongoose';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  getTransactionSupport,
  supportsTransactions,
  startRequiredTransactionSession,
  TransactionUnavailableError,
  withRequiredTransaction,
} from './transactions';

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

  it('reuses a required-session verdict instead of probing every subsequent transition', async () => {
    const db = new mongoose.Mongoose();
    await db.connect(repl.getUri(), { readPreference: 'secondaryPreferred' });
    const starts = jest.spyOn(db.connection.getClient(), 'startSession');
    try {
      const first = await startRequiredTransactionSession(db);
      await first.endSession();
      const second = await startRequiredTransactionSession(db);
      await second.endSession();
      expect(starts).toHaveBeenCalledTimes(3); // One probe and two actual owned sessions.
      expect(starts).toHaveBeenLastCalledWith({
        defaultTransactionOptions: { readPreference: 'primary' },
      });
    } finally {
      await db.disconnect();
    }
  });

  it('retries a required-session probe after an operational failure', async () => {
    const db = new mongoose.Mongoose();
    await db.connect(repl.getUri());
    const failure = new db.mongo.MongoNetworkError('test probe unavailable');
    const starts = jest.spyOn(db, 'startSession').mockRejectedValueOnce(failure);
    try {
      await expect(startRequiredTransactionSession(db)).rejects.toBe(failure);
      const session = await startRequiredTransactionSession(db);
      await session.endSession();
      expect(starts).toHaveBeenCalledTimes(2); // Failed probe, then successful probe.
    } finally {
      await db.disconnect();
    }
  });

  it('rechecks a required-session verdict when the connection gets a different client', async () => {
    const db = new mongoose.Mongoose();
    try {
      await db.connect(mongo.getUri());
      await expect(startRequiredTransactionSession(db)).rejects.toBeInstanceOf(
        TransactionUnavailableError,
      );
      await db.disconnect();
      await db.connect(repl.getUri(), { readPreference: 'secondaryPreferred' });
      const session = await startRequiredTransactionSession(db);
      await session.endSession();
    } finally {
      await db.disconnect();
    }
  });

  it('does not open feature sessions after confirmed lack of transaction support', async () => {
    const starts = jest.spyOn(standalone, 'startSession');
    await expect(startRequiredTransactionSession(standalone)).rejects.toBeInstanceOf(
      TransactionUnavailableError,
    );
    await expect(startRequiredTransactionSession(standalone)).rejects.toBeInstanceOf(
      TransactionUnavailableError,
    );
    expect(starts).toHaveBeenCalledTimes(1);
  });

  it('rejects an old pending verdict and probes the replacement client before private effects', async () => {
    const db = new mongoose.Mongoose();
    await db.connect(repl.getUri());
    const probeSession = await db.startSession();
    const commit = probeSession.commitTransaction.bind(probeSession);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    const committed = new Promise<void>((resolve) => (entered = resolve));
    jest.spyOn(probeSession, 'commitTransaction').mockImplementationOnce(async () => {
      await commit();
      entered();
      await paused;
    });
    const starts = jest.spyOn(db, 'startSession').mockResolvedValueOnce(probeSession);
    const prepare = jest.fn(async () => undefined);
    const write = jest.fn(async () => 'private-effect');
    try {
      const stale = withRequiredTransaction(db, write, prepare);
      await committed;
      await db.disconnect();
      await db.connect(mongo.getUri());
      const current = withRequiredTransaction(db, write, prepare);
      const outcomes = Promise.allSettled([stale, current]);
      release();
      expect(await outcomes).toEqual([
        { status: 'rejected', reason: expect.any(db.mongo.MongoNetworkError) },
        { status: 'rejected', reason: expect.any(TransactionUnavailableError) },
      ]);
      await expect(startRequiredTransactionSession(db)).rejects.toBeInstanceOf(
        TransactionUnavailableError,
      );
      expect(starts).toHaveBeenCalledTimes(2); // The old probe and a fresh standalone probe.
      expect(prepare).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      release();
      await db.disconnect();
    }
  });

  it('rechecks the client after awaiting a cached capability verdict', async () => {
    const db = new mongoose.Mongoose();
    await db.connect(repl.getUri());
    try {
      const session = await startRequiredTransactionSession(db);
      await session.endSession();
      const client = db.connection.getClient();
      jest
        .spyOn(db.connection, 'getClient')
        .mockReturnValueOnce(client)
        .mockReturnValueOnce(standalone.connection.getClient());
      const starts = jest.spyOn(db, 'startSession');
      await expect(startRequiredTransactionSession(db)).rejects.toBeInstanceOf(
        db.mongo.MongoNetworkError,
      );
      expect(starts).not.toHaveBeenCalled();
    } finally {
      await db.disconnect();
    }
  });
});
