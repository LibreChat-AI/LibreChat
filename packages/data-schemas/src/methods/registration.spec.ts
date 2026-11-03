import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ManagedRegistration } from '~/types/managed';
import { registerResponseTarget, settleResponseTarget } from './registration';
import { allocateManagedTarget, managedTargetFilter } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { createMessageModel } from '~/models/message';
import { responseScopeKeys } from './responseScope';

describe('bounded Response target discovery on real storage', () => {
  const standalone = new mongoose.Mongoose();
  const replica = new mongoose.Mongoose();
  const ferret = process.env.FERRETDB_URI ? new mongoose.Mongoose() : undefined;
  const engines: Array<readonly [string, typeof standalone]> = [
    ['standalone', standalone],
    ['replica', replica],
    ...(ferret ? [['FerretDB', ferret] as const] : []),
  ];
  let mongo: MongoMemoryServer;
  let repl: MongoMemoryReplSet;
  beforeAll(async () => {
    [mongo, repl] = await Promise.all([
      MongoMemoryServer.create(),
      MongoMemoryReplSet.create({ replSet: { count: 1 } }),
    ]);
    await Promise.all([
      standalone.connect(mongo.getUri()),
      replica.connect(repl.getUri(), {
        readPreference: 'secondaryPreferred',
      }),
    ]);
    if (ferret)
      await ferret.connect(process.env.FERRETDB_URI!, {
        dbName: `registration_${randomUUID().replace(/-/g, '')}`,
      });
    for (const [, db] of engines) {
      await createMessageModel(db).init();
      await createResponseScopeModel(db).init();
    }
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(engines.map(([, db]) => db.disconnect()));
    await Promise.all([mongo?.stop(), repl?.stop()]);
  });

  describe.each(engines)('%s', (_name, db) => {
    async function fixture() {
      const owner = { userId: randomUUID() };
      const conversationId = randomUUID();
      const target = await allocateManagedTarget(db, 'message');
      const entry: ManagedRegistration = {
        key: createHash('sha256').update(randomUUID()).digest('hex'),
        target,
        retentionEpoch: 0,
      };
      const keys = responseScopeKeys(owner, conversationId);
      return { owner, conversationId, target, entry, keys };
    }

    it('keeps duplicate registration and settlement idempotent under concurrency', async () => {
      const f = await fixture();
      const results = await Promise.all(
        Array.from({ length: 16 }, () => registerResponseTarget(db, f.owner, undefined, f.entry)),
      );
      expect(results.every((result) => result.status === 'registered')).toBe(true);
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [f.entry],
      });
      expect(await settleResponseTarget(db, f.owner, undefined, f.entry, 0)).toBe(false);
      // Fixture publication installs the cleanup lineage in the same write as payload.
      await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
        $set: {
          user: f.owner.userId,
          conversationId: f.conversationId,
          text: 'confirmed',
          '_managed.phase': 'published',
          '_managed.ownerKey': f.keys[0],
          '_managed.conversationKey': f.keys[1],
        },
      });
      const settled = await Promise.all(
        Array.from({ length: 16 }, () => settleResponseTarget(db, f.owner, undefined, f.entry, 0)),
      );
      expect(settled.filter(Boolean)).toHaveLength(1);
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 0,
        pending: [],
      });
    });

    it('bounds concurrent distinct registrations without counter drift', async () => {
      const f = await fixture();
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          registerResponseTarget(
            db,
            f.owner,
            undefined,
            {
              ...f.entry,
              key: createHash('sha256').update(String(i)).digest('hex'),
            },
            { maxPendingTargetsPerScope: 3 },
          ),
        ),
      );
      expect(results.filter((result) => result.status === 'registered')).toHaveLength(3);
      expect(results.filter((result) => result.status === 'capacity')).toHaveLength(9);
      const anchor = await createResponseScopeModel(db).findById(f.keys[0]).lean();
      expect(anchor?.pendingCount).toBe(3);
      expect(anchor?.pending).toHaveLength(3);
    });

    it('rejects reuse of a registration key for a different immutable identity', async () => {
      const f = await fixture();
      await registerResponseTarget(db, f.owner, undefined, f.entry);
      expect(
        await registerResponseTarget(db, f.owner, undefined, {
          ...f.entry,
          target: { ...f.target, incarnation: randomUUID() },
        }),
      ).toEqual({ status: 'conflict' });
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
      });
    });

    it('retains discovery after closure and refuses late registration or settlement', async () => {
      const f = await fixture();
      await registerResponseTarget(db, f.owner, f.conversationId, f.entry);
      await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
        $set: {
          user: f.owner.userId,
          conversationId: f.conversationId,
          '_managed.phase': 'published',
          '_managed.conversationKey': f.keys[1],
        },
      });
      await createResponseScopeModel(db).updateOne({ _id: f.keys[1] }, { $set: { closed: true } });
      expect(await registerResponseTarget(db, f.owner, f.conversationId, f.entry)).toEqual({
        status: 'closed',
      });
      expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry, 0)).toBe(false);
      expect(await createResponseScopeModel(db).findById(f.keys[1]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [f.entry],
      });
    });

    it('requires indexed ownership and the current retention deadline before handoff', async () => {
      const f = await fixture();
      await registerResponseTarget(db, f.owner, f.conversationId, f.entry);
      const deadline = new Date(Date.now() + 60000);
      await createResponseScopeModel(db).updateOne(
        { _id: f.keys[1] },
        {
          $set: { expiredAt: deadline, retentionEpoch: 1 },
        },
      );
      await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
        $set: {
          user: f.owner.userId,
          conversationId: f.conversationId,
          '_managed.phase': 'published',
          '_managed.conversationKey': f.keys[1],
        },
      });
      expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry, 0)).toBe(false);
      expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry, 1)).toBe(false);
      await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
        $set: { expiredAt: deadline },
      });
      expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry, 1)).toBe(true);
    });

    it('recovers an applied registration with a lost acknowledgment without incrementing twice', async () => {
      const f = await fixture();
      const scopes = createResponseScopeModel(db);
      await scopes.create({ _id: f.keys[0], closed: false, revision: 0 });
      const original = scopes.collection.findOneAndUpdate.bind(scopes.collection);
      jest.spyOn(scopes.collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new db.mongo.MongoNetworkError('test acknowledgment lost');
      });
      await expect(registerResponseTarget(db, f.owner, undefined, f.entry)).rejects.toBeInstanceOf(
        db.mongo.MongoNetworkError,
      );
      expect(await registerResponseTarget(db, f.owner, undefined, f.entry)).toMatchObject({
        status: 'registered',
      });
      expect(await scopes.findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [f.entry],
      });
    });

    it('rejects oversized metadata and invalid capacities before admission', async () => {
      const f = await fixture();
      await expect(
        registerResponseTarget(db, f.owner, undefined, f.entry, {
          maxPendingTargetsPerScope: 4097,
        }),
      ).rejects.toThrow();
      await expect(
        registerResponseTarget(db, f.owner, undefined, {
          ...f.entry,
          key: 'x'.repeat(10000),
        }),
      ).rejects.toThrow(TypeError);
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toBeNull();
    });
  });
});
