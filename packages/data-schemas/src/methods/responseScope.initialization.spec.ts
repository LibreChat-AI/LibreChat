import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { closeResponseScopes, initializeResponseScopes, responseScopeKeys } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { createStoredResponseModel } from '~/models/response';

interface ScopeFixture {
  _id: string;
  closed: boolean;
  revision: number;
  expiredAt?: Date;
  pending?: { key: string }[];
}

describe('Response scope creation preserves lifecycle authority', () => {
  const standalone = new mongoose.Mongoose();
  const replica = new mongoose.Mongoose();
  const ferret = process.env.FERRETDB_URI ? new mongoose.Mongoose() : undefined;
  const engines = [
    ['standalone', standalone],
    ['replica', replica],
    ...(ferret ? [['FerretDB', ferret] as const] : []),
  ] as const;
  let mongo: MongoMemoryServer;
  let repl: MongoMemoryReplSet;

  beforeAll(async () => {
    [mongo, repl] = await Promise.all([
      MongoMemoryServer.create(),
      MongoMemoryReplSet.create({ replSet: { count: 1 } }),
    ]);
    await standalone.connect(mongo.getUri());
    await replica.connect(repl.getUri());
    if (ferret)
      await ferret.connect(process.env.FERRETDB_URI!, {
        dbName: `scope_initialization_${randomUUID().replace(/-/g, '')}`,
      });
    for (const [, db] of engines) {
      await createResponseScopeModel(db).createCollection();
      await createStoredResponseModel(db).createCollection();
    }
  }, 60000);

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(engines.map(([, db]) => db.disconnect()));
    await mongo?.stop();
    await repl?.stop();
  });

  describe.each(engines)('%s', (_name, db) => {
    // Raw fixture writes represent lifecycle state owned by callers, including future fields.
    const rows = () => db.connection.db!.collection<ScopeFixture>('responsescopes');

    it.each([false, true])(
      'retains every acknowledged lifecycle mutation during concurrent cold creation (closed: %s)',
      async (closed) => {
        const owner = { userId: randomUUID() };
        const key = responseScopeKeys(owner, '')[0];
        const deadline = new Date(Date.now() + 60000);
        await Promise.all(
          Array.from({ length: 12 }, async (_, index) => {
            if (closed) await closeResponseScopes(db, owner);
            else await initializeResponseScopes(db, [key]);
            await rows().updateOne(
              { _id: key },
              {
                $inc: { revision: 1 },
                $push: { pending: { key: String(index) } },
                $min: { expiredAt: deadline },
              },
            );
          }),
        );
        const stored = await rows().findOne({ _id: key });
        expect(stored).toMatchObject({ closed, revision: 12, expiredAt: deadline });
        expect(stored?.pending).toHaveLength(12);
        expect(new Set(stored?.pending?.map((entry: { key: string }) => entry.key)).size).toBe(12);
      },
    );

    it('preserves existing closure, revision, retention and discovery during repeated initialization', async () => {
      const key = randomUUID();
      const deadline = new Date(Date.now() + 60000);
      await rows().insertOne({
        _id: key,
        closed: true,
        revision: 42,
        expiredAt: deadline,
        pending: [{ key: 'retained' }],
      });
      await Promise.all(Array.from({ length: 12 }, () => initializeResponseScopes(db, [key])));
      expect(await rows().findOne({ _id: key })).toMatchObject({
        closed: true,
        revision: 42,
        expiredAt: deadline,
        pending: [{ key: 'retained' }],
      });
    });
  });

  describe.each(engines)('%s initialization failures and sessions', (_name, db) => {
    const rows = () => db.connection.db!.collection<ScopeFixture>('responsescopes');

    it('does not reopen a tombstone created while an initializer is delayed', async () => {
      const model = createResponseScopeModel(db);
      const write = model.bulkWrite.bind(model);
      const owner = { userId: randomUUID() };
      const key = responseScopeKeys(owner, '')[0];
      const deadline = new Date(Date.now() + 60000);
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (enter = resolve));
      const resumed = new Promise<void>((resolve) => (release = resolve));
      jest.spyOn(model, 'bulkWrite').mockImplementationOnce(async (operations, options) => {
        enter();
        await resumed;
        return write(operations, options);
      });
      const pending = initializeResponseScopes(db, [key]);
      try {
        await entered;
        await closeResponseScopes(db, owner);
        await rows().updateOne(
          { _id: key },
          { $set: { revision: 42, expiredAt: deadline, pending: [{ key: 'retained' }] } },
        );
      } finally {
        release();
      }
      await pending;
      expect(await rows().findOne({ _id: key })).toMatchObject({
        closed: true,
        revision: 42,
        expiredAt: deadline,
        pending: [{ key: 'retained' }],
      });
    });

    it('propagates a lost insert acknowledgment and safely observes the row on retry', async () => {
      const model = createResponseScopeModel(db);
      const write = model.bulkWrite.bind(model);
      const key = randomUUID();
      const failure = new mongoose.mongo.MongoNetworkError('fixture lost acknowledgment');
      jest.spyOn(model, 'bulkWrite').mockImplementationOnce(async (operations, options) => {
        await write(operations, options);
        throw failure;
      });
      await expect(initializeResponseScopes(db, [key])).rejects.toBe(failure);
      await rows().updateOne({ _id: key }, { $set: { closed: true, revision: 9 } });
      await initializeResponseScopes(db, [key]);
      expect(await rows().findOne({ _id: key })).toMatchObject({ closed: true, revision: 9 });
    });

    it('requires exact-key proof before accepting a duplicate from creation', async () => {
      const model = createResponseScopeModel(db);
      const existing = randomUUID();
      const missing = randomUUID();
      const document = { _id: existing, closed: false, revision: 0 };
      await model.create(document);
      let failure: unknown;
      try {
        await model.bulkWrite([{ insertOne: { document } }]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(mongoose.mongo.MongoBulkWriteError);
      jest.spyOn(model, 'bulkWrite').mockRejectedValueOnce(failure);
      await expect(initializeResponseScopes(db, [missing])).rejects.toBe(failure);
      expect(await model.exists({ _id: missing })).toBeNull();
    });

    it('keeps a supplied inactive session outside transactions and owned by its caller', async () => {
      const session = await db.startSession();
      const key = randomUUID();
      try {
        await initializeResponseScopes(db, [key], session);
        await rows().updateOne({ _id: key }, { $set: { closed: true, revision: 5 } });
        await initializeResponseScopes(db, [key], session);
        expect(session.inTransaction()).toBe(false);
        expect(session.hasEnded).toBe(false);
        expect(await rows().findOne({ _id: key })).toMatchObject({ closed: true, revision: 5 });
      } finally {
        await session.endSession();
      }
    });
  });

  it('refuses unacknowledged cold creation before writing an authority record', async () => {
    const db = new mongoose.Mongoose();
    const key = randomUUID();
    try {
      await db.connect(mongo.getUri(), { writeConcern: { w: 0 } });
      createResponseScopeModel(db);
      await expect(initializeResponseScopes(db, [key])).rejects.toThrow(
        'requires acknowledged writes',
      );
      expect(await createResponseScopeModel(standalone).exists({ _id: key })).toBeNull();
    } finally {
      await db.disconnect();
    }
  });

  describe('active parent transactions', () => {
    it('creates and mutates anchors inside the caller snapshot and rolls back with it', async () => {
      const model = createResponseScopeModel(replica);
      const session = await replica.startSession();
      const committed = randomUUID();
      const aborted = randomUUID();
      try {
        await session.withTransaction(async () => {
          await initializeResponseScopes(replica, [committed], session);
          await model.updateOne({ _id: committed }, { $set: { revision: 7 } }, { session });
          await initializeResponseScopes(replica, [committed], session);
        });
        expect(await model.findById(committed).lean()).toMatchObject({ revision: 7 });
        session.startTransaction();
        await initializeResponseScopes(replica, [aborted], session);
        await session.abortTransaction();
        expect(await model.exists({ _id: aborted })).toBeNull();
        expect(session.hasEnded).toBe(false);
      } finally {
        await session.endSession();
      }
    });

    it('propagates a duplicate without recovery reads in the parent transaction', async () => {
      const model = createResponseScopeModel(replica);
      const session = await replica.startSession();
      const failure = new mongoose.mongo.MongoServerError({
        code: 11000,
        message: 'fixture duplicate',
      });
      const reads = jest.spyOn(model, 'find');
      jest.spyOn(model, 'updateOne').mockImplementationOnce(() => {
        throw failure;
      });
      try {
        session.startTransaction();
        await expect(initializeResponseScopes(replica, [randomUUID()], session)).rejects.toBe(
          failure,
        );
        expect(reads).not.toHaveBeenCalled();
        expect(session.hasEnded).toBe(false);
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
    });
  });

  it('bounds cold closure batches and deduplicates repeated conversation keys', async () => {
    const owner = { userId: randomUUID() };
    const ids = Array.from({ length: 501 }, () => randomUUID());
    const model = createResponseScopeModel(standalone);
    const writes = jest.spyOn(model, 'bulkWrite');
    await closeResponseScopes(standalone, owner, [...ids, ids[0]]);
    const keys = ids.map((id) => responseScopeKeys(owner, id)[1]);
    expect(await model.countDocuments({ _id: { $in: keys }, closed: true })).toBe(501);
    expect(writes).toHaveBeenCalledTimes(6);
    for (const [operations] of writes.mock.calls)
      expect(operations.length).toBeLessThanOrEqual(250);
  });
});
