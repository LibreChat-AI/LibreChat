import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ManagedRegistration } from '~/types/managed';
import {
  registerResponseTarget,
  settleResponseTarget,
  settleAbsentResponseTarget,
  reconcileResponseTargets,
} from './registration';
import { responseScopeKeys, createResponseRetention } from './responseScope';
import { allocateManagedTarget, managedTargetFilter } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { createManagedMessageId } from '~/utils/managed';
import { createMessageModel } from '~/models/message';
import { createResponseStorage } from './response';

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
      await createMessageModel(db).createIndexes();
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
      expect(await settleResponseTarget(db, f.owner, undefined, f.entry)).toBe(false);
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
        Array.from({ length: 16 }, () => settleResponseTarget(db, f.owner, undefined, f.entry)),
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
      expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry)).toBe(false);
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
      expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry)).toBe(false);
      await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
        $set: { expiredAt: deadline },
      });
      expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry)).toBe(true);
    });

    it('adopts actual retained conversation state independently from the owner epoch', async () => {
      const f = await fixture();
      const deadline = new Date(Date.now() + 120000);
      await createResponseRetention(db)(f.owner, f.conversationId, deadline);
      const intent = { key: f.entry.key, target: f.target };
      expect(await registerResponseTarget(db, f.owner, f.conversationId, intent)).toEqual({
        status: 'registered',
        retentionEpoch: 1,
        expiredAt: deadline,
      });
      expect(await registerResponseTarget(db, f.owner, undefined, intent)).toEqual({
        status: 'registered',
        retentionEpoch: 0,
      });
      const scopes = createResponseScopeModel(db);
      expect(await scopes.findById(f.keys[1]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [{ ...intent, retentionEpoch: 1 }],
      });
      expect(await scopes.findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [{ ...intent, retentionEpoch: 0 }],
      });
      const shorter = new Date(Date.now() + 60000);
      await createResponseRetention(db)(f.owner, f.conversationId, shorter);
      expect(await registerResponseTarget(db, f.owner, f.conversationId, intent)).toEqual({
        status: 'registered',
        retentionEpoch: 2,
        expiredAt: shorter,
      });
      expect(await scopes.findById(f.keys[1]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [{ ...intent, retentionEpoch: 1 }],
      });
      await db.model('Message').collection.deleteOne(managedTargetFilter(db, f.target));
      expect(await settleAbsentResponseTarget(db, f.owner, f.conversationId, intent)).toBe(true);
    });

    it('retries actual retention changes between admission snapshot and write', async () => {
      const f = await fixture();
      const scopes = createResponseScopeModel(db);
      const update = scopes.collection.findOneAndUpdate.bind(scopes.collection);
      const deadline = new Date(Date.now() + 60000);
      jest.spyOn(scopes.collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
        await createResponseRetention(db)(f.owner, f.conversationId, deadline);
        return update(...args);
      });
      expect(
        await registerResponseTarget(db, f.owner, f.conversationId, {
          key: f.entry.key,
          target: f.target,
        }),
      ).toEqual({ status: 'registered', retentionEpoch: 1, expiredAt: deadline });
      expect(await scopes.findById(f.keys[1]).lean()).toMatchObject({ pendingCount: 1 });
    });

    it('retries when a competing duplicate is settled before admission readback', async () => {
      const f = await fixture();
      const scopes = createResponseScopeModel(db);
      await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
        $set: {
          user: f.owner.userId,
          '_managed.phase': 'published',
          '_managed.ownerKey': f.keys[0],
        },
      });
      const update = scopes.collection.findOneAndUpdate.bind(scopes.collection);
      jest.spyOn(scopes.collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
        await update(...args); // A competing publisher wins this operation first.
        const lost = await update(...args);
        expect(await settleResponseTarget(db, f.owner, undefined, f.entry)).toBe(true);
        return lost;
      });
      expect(await registerResponseTarget(db, f.owner, undefined, f.entry)).toMatchObject({
        status: 'registered',
      });
      expect(await scopes.findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [f.entry],
      });
    });

    it('retries capacity after another settler frees space outside reconciliation', async () => {
      const f = await fixture();
      await registerResponseTarget(db, f.owner, undefined, f.entry);
      await db.model('Message').collection.deleteOne(managedTargetFilter(db, f.target));
      const next = await allocateManagedTarget(db, 'message');
      const scopes = createResponseScopeModel(db);
      const read = scopes.collection.findOne.bind(scopes.collection);
      jest.spyOn(scopes.collection, 'findOne').mockImplementationOnce(async (...args) => {
        const full = await read(...args);
        expect(await settleAbsentResponseTarget(db, f.owner, undefined, f.entry)).toBe(true);
        return full;
      });
      expect(
        await registerResponseTarget(
          db,
          f.owner,
          undefined,
          {
            key: createHash('sha256').update(randomUUID()).digest('hex'),
            target: next,
          },
          { maxPendingTargetsPerScope: 1 },
        ),
      ).toMatchObject({ status: 'registered' });
      expect(await scopes.findById(f.keys[0]).lean()).toMatchObject({ pendingCount: 1 });
    });

    it('returns typed retry after repeated admission contention without hiding outages', async () => {
      const f = await fixture();
      const scopes = createResponseScopeModel(db);
      const update = scopes.collection.findOneAndUpdate.bind(scopes.collection);
      const attempts = jest
        .spyOn(scopes.collection, 'findOneAndUpdate')
        .mockImplementation(async (...args) => {
          await scopes.updateOne({ _id: f.keys[0] }, { $inc: { retentionEpoch: 1 } });
          return update(...args);
        });
      expect(await registerResponseTarget(db, f.owner, undefined, f.entry)).toEqual({
        status: 'retry',
      });
      expect(attempts).toHaveBeenCalledTimes(2);
      expect(await scopes.findById(f.keys[0]).lean()).not.toHaveProperty('pendingCount');
    });

    describe('portable reservation coexistence', () => {
      it('keeps discovery if real reservation shortens retention after canonical proof', async () => {
        const f = await fixture();
        const storage = createResponseStorage(db);
        const reserve = (expiredAt: Date) =>
          storage.reserve({
            ...f.owner,
            conversationId: f.conversationId,
            responseId: createManagedMessageId(),
            requestKey: randomUUID(),
            fingerprint: randomUUID(),
            agentId: 'agent',
            requestJSON: '{}',
            parentMessageId: 'root',
            expiredAt,
          });
        const deadline = new Date(Date.now() + 120000);
        expect((await reserve(deadline)).ok).toBe(true);
        expect(
          await registerResponseTarget(db, f.owner, f.conversationId, {
            key: f.entry.key,
            target: f.target,
          }),
        ).toEqual({ status: 'registered', retentionEpoch: 1, expiredAt: deadline });
        await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
          $set: {
            user: f.owner.userId,
            conversationId: f.conversationId,
            expiredAt: deadline,
            '_managed.phase': 'published',
            '_managed.conversationKey': f.keys[1],
          },
        });
        const scopes = createResponseScopeModel(db);
        const update = scopes.collection.updateOne.bind(scopes.collection);
        const shorter = new Date(Date.now() + 60000);
        jest.spyOn(scopes.collection, 'updateOne').mockImplementationOnce(async (...args) => {
          expect((await reserve(shorter)).ok).toBe(true);
          return update(...args);
        });
        expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry)).toBe(false);
        expect(await scopes.findById(f.keys[1]).lean()).toMatchObject({
          retentionEpoch: 2,
          expiredAt: shorter,
          pendingCount: 1,
          pending: [{ key: f.entry.key, target: f.target, retentionEpoch: 1 }],
        });
        expect(
          await db.model('Message').collection.findOne(managedTargetFilter(db, f.target)),
        ).toMatchObject({ expiredAt: shorter });
        expect(await settleResponseTarget(db, f.owner, f.conversationId, f.entry)).toBe(true);
      });
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

    it('does not mistake hidden allocations for physically absent targets', async () => {
      const f = await fixture();
      await registerResponseTarget(db, f.owner, undefined, f.entry);
      expect(await settleAbsentResponseTarget(db, f.owner, undefined, f.entry)).toBe(false);
      expect(await reconcileResponseTargets(db, f.owner)).toBe(0);
      await db.model('Message').collection.deleteOne(managedTargetFilter(db, f.target));
      expect(await reconcileResponseTargets(db, f.owner)).toBe(1);
      expect(await reconcileResponseTargets(db, f.owner)).toBe(0);
    });

    it.each(['owner', 'conversation'] as const)(
      'reclaims an interrupted published %s registration before reporting capacity',
      async (role) => {
        const f = await fixture();
        const conversationId = role === 'conversation' ? f.conversationId : undefined;
        await registerResponseTarget(db, f.owner, conversationId, f.entry);
        await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
          $set: {
            user: f.owner.userId,
            conversationId: f.conversationId,
            '_managed.phase': 'published',
            '_managed.ownerKey': f.keys[0],
            '_managed.conversationKey': f.keys[1],
          },
        });
        const next = await allocateManagedTarget(db, 'message');
        const entry = {
          key: createHash('sha256').update(randomUUID()).digest('hex'),
          target: next,
        };
        expect(
          await registerResponseTarget(db, f.owner, conversationId, entry, {
            maxPendingTargetsPerScope: 1,
          }),
        ).toMatchObject({ status: 'registered' });
        expect(
          await createResponseScopeModel(db)
            .findById(f.keys[role === 'owner' ? 0 : 1])
            .lean(),
        ).toMatchObject({ pendingCount: 1, pending: [{ ...entry, retentionEpoch: 0 }] });
      },
    );

    it.each(['owner', 'conversation', 'deadline'] as const)(
      'retains a published target without matching cleanup %s proof',
      async (mismatch) => {
        const f = await fixture();
        const deadline = new Date(Date.now() + 60000);
        await createResponseRetention(db)(f.owner, f.conversationId, deadline);
        const intent = { key: f.entry.key, target: f.target };
        await registerResponseTarget(db, f.owner, f.conversationId, intent);
        await db.model('Message').collection.updateOne(managedTargetFilter(db, f.target), {
          $set: {
            user: mismatch === 'owner' ? 'other' : f.owner.userId,
            conversationId: mismatch === 'conversation' ? randomUUID() : f.conversationId,
            expiredAt: mismatch === 'deadline' ? new Date(deadline.getTime() + 1000) : deadline,
            '_managed.phase': 'published',
            '_managed.conversationKey': f.keys[1],
          },
        });
        expect(await reconcileResponseTargets(db, f.owner, f.conversationId)).toBe(0);
        expect(await createResponseScopeModel(db).findById(f.keys[1]).lean()).toMatchObject({
          pendingCount: 1,
        });
      },
    );

    it('reconciles a full registry with one anchor read and one batched target read', async () => {
      const f = await fixture();
      const entries = [];
      for (let i = 0; i < 8; i++) {
        const target = await allocateManagedTarget(db, 'message');
        const entry = {
          ...f.entry,
          target,
          key: createHash('sha256').update(randomUUID()).digest('hex'),
        };
        entries.push(entry);
        await registerResponseTarget(db, f.owner, undefined, entry);
        if (i < 4) await db.model('Message').collection.deleteOne(managedTargetFilter(db, target));
      }
      const scopes = createResponseScopeModel(db);
      const scopeReads = jest.spyOn(scopes.collection, 'findOne');
      const targetReads = jest.spyOn(db.model('Message').collection, 'find');
      const settlements = jest.spyOn(scopes.collection, 'bulkWrite');
      expect(await reconcileResponseTargets(db, f.owner)).toBe(4);
      expect(scopeReads).toHaveBeenCalledTimes(1);
      expect(targetReads).toHaveBeenCalledTimes(1);
      expect(settlements).toHaveBeenCalledTimes(1);
      expect(await scopes.findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 4,
        pending: entries.slice(4),
      });
    });

    it('keeps discovery for valid uppercase physical IDs returned by an adapter', async () => {
      const f = await fixture();
      const entry = { ...f.entry, target: { ...f.target, id: f.target.id.toUpperCase() } };
      await registerResponseTarget(db, f.owner, undefined, entry);
      expect(await reconcileResponseTargets(db, f.owner)).toBe(0);
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [entry],
      });
    });

    it('settles both representations of the tenantless partition consistently', async () => {
      const f = await fixture();
      const entry = { ...f.entry, target: { ...f.target, tenantId: '' } };
      await registerResponseTarget(db, f.owner, undefined, entry);
      await db.model('Message').collection.deleteOne(managedTargetFilter(db, f.target));
      expect(await settleAbsentResponseTarget(db, f.owner, undefined, f.entry)).toBe(true);
      await registerResponseTarget(db, f.owner, undefined, entry);
      expect(await reconcileResponseTargets(db, f.owner)).toBe(1);
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 0,
        pending: [],
      });
    });

    it('reclaims a delayed registration again without needing a retained parent', async () => {
      const f = await fixture();
      await registerResponseTarget(db, f.owner, undefined, f.entry);
      await db.model('Message').collection.deleteOne(managedTargetFilter(db, f.target));
      expect(await settleAbsentResponseTarget(db, f.owner, undefined, f.entry)).toBe(true);
      // A registrar paused before its command may resume after erasure and parent removal.
      expect(await registerResponseTarget(db, f.owner, undefined, f.entry)).toMatchObject({
        status: 'registered',
      });
      const next = await allocateManagedTarget(db, 'message');
      const nextEntry = {
        ...f.entry,
        target: next,
        key: createHash('sha256').update(randomUUID()).digest('hex'),
      };
      expect(
        await registerResponseTarget(db, f.owner, undefined, nextEntry, {
          maxPendingTargetsPerScope: 1,
        }),
      ).toMatchObject({ status: 'registered' });
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
        pending: [nextEntry],
      });
    });

    it.each(['closure', 'retention'] as const)(
      'retains discovery if %s changes after absence proof',
      async (change) => {
        const f = await fixture();
        await registerResponseTarget(db, f.owner, undefined, f.entry);
        await db.model('Message').collection.deleteOne(managedTargetFilter(db, f.target));
        const scopes = createResponseScopeModel(db);
        const update = scopes.collection.updateOne.bind(scopes.collection);
        jest.spyOn(scopes.collection, 'updateOne').mockImplementationOnce(async (...args) => {
          await scopes.updateOne(
            { _id: f.keys[0] },
            { $set: change === 'closure' ? { closed: true } : { retentionEpoch: 1 } },
          );
          return update(...args);
        });
        expect(await settleAbsentResponseTarget(db, f.owner, undefined, f.entry)).toBe(false);
        expect(await scopes.findById(f.keys[0]).lean()).toMatchObject({
          pendingCount: 1,
          pending: [f.entry],
        });
      },
    );

    it.each(['closure', 'retention'] as const)(
      'guards batched settlement against concurrent %s',
      async (change) => {
        const f = await fixture();
        await registerResponseTarget(db, f.owner, undefined, f.entry);
        await db.model('Message').collection.deleteOne(managedTargetFilter(db, f.target));
        const scopes = createResponseScopeModel(db);
        const bulkWrite = scopes.collection.bulkWrite.bind(scopes.collection);
        jest.spyOn(scopes.collection, 'bulkWrite').mockImplementationOnce(async (...args) => {
          await scopes.updateOne(
            { _id: f.keys[0] },
            { $set: change === 'closure' ? { closed: true } : { retentionEpoch: 1 } },
          );
          return bulkWrite(...args);
        });
        expect(await reconcileResponseTargets(db, f.owner)).toBe(0);
        expect(await scopes.findById(f.keys[0]).lean()).toMatchObject({
          pendingCount: 1,
          pending: [f.entry],
        });
      },
    );

    it('propagates primary absence-read failures without losing discovery', async () => {
      const f = await fixture();
      await registerResponseTarget(db, f.owner, undefined, f.entry);
      jest.spyOn(db.model('Message').collection, 'find').mockImplementationOnce(() => {
        throw new Error('test storage outage');
      });
      await expect(reconcileResponseTargets(db, f.owner)).rejects.toThrow('test storage outage');
      expect(await createResponseScopeModel(db).findById(f.keys[0]).lean()).toMatchObject({
        pendingCount: 1,
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
