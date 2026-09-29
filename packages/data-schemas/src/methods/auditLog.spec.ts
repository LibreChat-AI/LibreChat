import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { RecordAuditEntryInput } from '~/types';
import type * as t from '~/types';
import auditLogSchema, { GENESIS_HASH, PLATFORM_CHAIN_KEY } from '~/schema/auditLog';
import { auditChainKey, createAuditLogMethods } from './auditLog';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let AuditLog: mongoose.Model<t.IAuditLog>;
let methods: ReturnType<typeof createAuditLogMethods>;

const actorObjectId = new Types.ObjectId();
const CK_A = auditChainKey('tenant-a');
const CK_B = auditChainKey('tenant-b');

function baseInput(over: Partial<RecordAuditEntryInput> = {}): RecordAuditEntryInput {
  return {
    action: 'grant.assigned',
    actor: { type: 'user', id: actorObjectId, name: 'Alice Admin' },
    target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
    metadata: { capability: 'manage:users' },
    tenantId: 'tenant-a',
    ...over,
  };
}

async function seed(count: number, over: Partial<RecordAuditEntryInput> = {}): Promise<void> {
  for (let i = 0; i < count; i++) {
    await methods.recordAuditEntry(baseInput({ metadata: { capability: `cap:${i}` }, ...over }));
  }
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  AuditLog = mongoose.models.AuditLog || mongoose.model<t.IAuditLog>('AuditLog', auditLogSchema);
  methods = createAuditLogMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  await AuditLog.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AuditLog.collection.deleteMany({});
});

describe('auditLog methods', () => {
  describe('recordAuditEntry', () => {
    it('persists a tenant-scoped entry with denormalized + derived fields', async () => {
      const doc = await methods.recordAuditEntry(baseInput());
      expect(doc).not.toBeNull();

      const persisted = await AuditLog.findOne({ chainKey: CK_A }).lean();
      expect(persisted).toMatchObject({
        schemaVersion: 1,
        category: 'grant',
        action: 'grant.assigned',
        outcome: 'success',
        severity: 'info',
        actor: { type: 'user', id: actorObjectId.toString(), name: 'Alice Admin' },
        target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
        metadata: { capability: 'manage:users' },
        tenantId: 'tenant-a',
        chainKey: CK_A,
        seq: 1,
        prevHash: GENESIS_HASH,
      });
      expect(persisted?.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(persisted?.createdAt).toBeInstanceOf(Date);
    });

    it('derives a warning severity for non-success outcomes', async () => {
      await methods.recordAuditEntry(baseInput({ outcome: 'denied' }));
      const persisted = await AuditLog.findOne({ chainKey: CK_A }).lean();
      expect(persisted?.outcome).toBe('denied');
      expect(persisted?.severity).toBe('warning');
    });

    it('starts each chain at the genesis hash and links subsequent entries', async () => {
      const first = await methods.recordAuditEntry(baseInput());
      const second = await methods.recordAuditEntry(baseInput());
      expect(first?.seq).toBe(1);
      expect(first?.prevHash).toBe(GENESIS_HASH);
      expect(second?.seq).toBe(2);
      expect(second?.prevHash).toBe(first?.hash);
    });

    it('keeps tenant and platform chains independent', async () => {
      await methods.recordAuditEntry(baseInput({ tenantId: 'tenant-a' }));
      await methods.recordAuditEntry(baseInput({ tenantId: 'tenant-b' }));
      await methods.recordAuditEntry(baseInput({ tenantId: undefined }));

      const a = await AuditLog.findOne({ chainKey: CK_A }).lean();
      const b = await AuditLog.findOne({ chainKey: CK_B }).lean();
      const platform = await AuditLog.findOne({ chainKey: PLATFORM_CHAIN_KEY }).lean();

      expect(a?.seq).toBe(1);
      expect(b?.seq).toBe(1);
      expect(platform?.seq).toBe(1);
      expect(platform?.tenantId).toBeUndefined();
    });

    it('treats a blank tenantId as platform scope (no literal "" stored)', async () => {
      await methods.recordAuditEntry(baseInput({ tenantId: '   ' }));
      const platform = await AuditLog.findOne({ chainKey: PLATFORM_CHAIN_KEY }).lean();
      expect(platform).not.toBeNull();
      expect(platform?.tenantId).toBeUndefined();
      const blank = await AuditLog.findOne({ tenantId: '' }).lean();
      expect(blank).toBeNull();
    });

    it('omits metadata/context entirely when empty', async () => {
      await methods.recordAuditEntry(
        baseInput({ metadata: {}, context: { ip: '', userAgent: undefined } }),
      );
      const persisted = await AuditLog.findOne({ chainKey: CK_A }).lean();
      expect(persisted?.metadata).toBeUndefined();
      expect(persisted?.context).toBeUndefined();
    });

    it('persists request context when provided', async () => {
      await methods.recordAuditEntry(
        baseInput({ context: { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-1' } }),
      );
      const persisted = await AuditLog.findOne({ chainKey: CK_A }).lean();
      expect(persisted?.context).toMatchObject({
        ip: '10.0.0.1',
        userAgent: 'jest',
        requestId: 'req-1',
      });
    });

    it('fail-open returns null on write failure; fail-closed throws', async () => {
      const spy = jest
        .spyOn(AuditLog, 'create')
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom'));

      await expect(methods.recordAuditEntry(baseInput())).resolves.toBeNull();
      await expect(methods.recordAuditEntry(baseInput(), { failClosed: true })).rejects.toThrow(
        'boom',
      );

      spy.mockRestore();
    });
  });

  describe('append-only enforcement', () => {
    it('rejects every query-level update and delete path', async () => {
      await methods.recordAuditEntry(baseInput());
      await expect(
        AuditLog.updateOne({ chainKey: CK_A }, { action: 'grant.removed' }),
      ).rejects.toThrow(/append-only/);
      await expect(AuditLog.updateMany({}, { seq: 9 })).rejects.toThrow(/append-only/);
      await expect(AuditLog.findOneAndUpdate({}, { seq: 9 })).rejects.toThrow(/append-only/);
      await expect(AuditLog.deleteOne({ chainKey: CK_A })).rejects.toThrow(/append-only/);
      await expect(AuditLog.deleteMany({ chainKey: CK_A })).rejects.toThrow(/append-only/);
      await expect(AuditLog.findOneAndDelete({})).rejects.toThrow(/append-only/);
    });

    it('rejects document-level re-save and deleteOne', async () => {
      await methods.recordAuditEntry(baseInput());
      const doc = await AuditLog.findOne({ chainKey: CK_A });
      expect(doc).not.toBeNull();
      await expect(doc!.save()).rejects.toThrow(/append-only/);
      await expect(doc!.deleteOne()).rejects.toThrow(/append-only/);
    });

    it('rejects bulkWrite (which would bypass query/document middleware)', async () => {
      await methods.recordAuditEntry(baseInput());
      await expect(
        AuditLog.bulkWrite([
          {
            updateOne: {
              filter: { chainKey: CK_A },
              update: { $set: { 'actor.name': 'x' } },
            },
          },
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects insertMany (which would let callers poison the chain)', async () => {
      await expect(
        AuditLog.insertMany([
          {
            schemaVersion: 1,
            category: 'grant',
            action: 'grant.assigned',
            outcome: 'success',
            severity: 'info',
            actor: { type: 'user', name: 'Mallory' },
            target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
            chainKey: CK_A,
            seq: 999,
            prevHash: GENESIS_HASH,
            hash: 'f'.repeat(64),
            createdAt: new Date(),
          },
        ]),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('listAuditLogPage', () => {
    it('returns newest-first entries with total and nextCursor', async () => {
      await seed(3);
      const page = await methods.listAuditLogPage('tenant-a', { limit: 2 });
      expect(page.total).toBe(3);
      expect(page.entries).toHaveLength(2);
      expect(page.entries[0].integrity.seq).toBe(3);
      expect(page.entries[1].integrity.seq).toBe(2);
      expect(page.nextCursor).toBe(2);
    });

    it('paginates by keyset cursor without duplicating rows under concurrent appends', async () => {
      await seed(4);
      const page1 = await methods.listAuditLogPage('tenant-a', { limit: 2 });
      const seenIds = new Set(page1.entries.map((e) => e.id));
      // a new entry lands at the head between page fetches
      await methods.recordAuditEntry(baseInput());
      const page2 = await methods.listAuditLogPage('tenant-a', {
        limit: 2,
        cursor: page1.nextCursor ?? undefined,
      });
      for (const entry of page2.entries) {
        expect(seenIds.has(entry.id)).toBe(false);
      }
      expect(page2.entries.map((e) => e.integrity.seq)).toEqual([2, 1]);
      expect(page2.nextCursor).toBeNull();
    });

    it('supports offset pagination', async () => {
      await seed(3);
      const page = await methods.listAuditLogPage('tenant-a', { limit: 1, offset: 1 });
      expect(page.entries[0].integrity.seq).toBe(2);
    });

    it('isolates tenants', async () => {
      await methods.recordAuditEntry(baseInput({ tenantId: 'tenant-a' }));
      await methods.recordAuditEntry(baseInput({ tenantId: 'tenant-b' }));
      const page = await methods.listAuditLogPage('tenant-a', {});
      expect(page.total).toBe(1);
      expect(page.entries[0].tenantId).toBe('tenant-a');
    });

    it('filters by action, outcome, severity, and actorType', async () => {
      await methods.recordAuditEntry(baseInput({ action: 'grant.assigned' }));
      await methods.recordAuditEntry(baseInput({ action: 'grant.removed', outcome: 'denied' }));

      expect(
        (await methods.listAuditLogPage('tenant-a', { action: ['grant.removed'] })).total,
      ).toBe(1);
      expect((await methods.listAuditLogPage('tenant-a', { outcome: ['denied'] })).total).toBe(1);
      expect((await methods.listAuditLogPage('tenant-a', { severity: ['warning'] })).total).toBe(1);
      expect((await methods.listAuditLogPage('tenant-a', { actorType: 'user' })).total).toBe(2);
      expect((await methods.listAuditLogPage('tenant-a', { actorType: 'agent' })).total).toBe(0);
    });

    it('substring-matches actorQuery, targetQuery, and capability case-insensitively', async () => {
      await methods.recordAuditEntry(
        baseInput({
          actor: { type: 'user', id: actorObjectId, name: 'Alice Admin' },
          target: { type: 'role', id: 'ADMIN', name: 'ADMIN' },
          metadata: { capability: 'manage:users' },
        }),
      );
      expect((await methods.listAuditLogPage('tenant-a', { actorQuery: 'alice' })).total).toBe(1);
      expect((await methods.listAuditLogPage('tenant-a', { targetQuery: 'admin' })).total).toBe(1);
      expect((await methods.listAuditLogPage('tenant-a', { capability: 'manage' })).total).toBe(1);
      expect((await methods.listAuditLogPage('tenant-a', { actorQuery: 'zzz' })).total).toBe(0);
    });

    it('filters by date window', async () => {
      await seed(2);
      const future = new Date(Date.now() + 60_000);
      const past = new Date(Date.now() - 60_000);
      expect((await methods.listAuditLogPage('tenant-a', { from: past, to: future })).total).toBe(
        2,
      );
      expect((await methods.listAuditLogPage('tenant-a', { from: future })).total).toBe(0);
    });
  });

  describe('findAuditLogEntry', () => {
    it('returns a single entry scoped to its tenant', async () => {
      const doc = await methods.recordAuditEntry(baseInput());
      const id = doc!._id.toString();
      const found = await methods.findAuditLogEntry('tenant-a', id);
      expect(found?.id).toBe(id);
      expect(await methods.findAuditLogEntry('tenant-b', id)).toBeNull();
    });

    it('returns null for a non-ObjectId id', async () => {
      expect(await methods.findAuditLogEntry('tenant-a', 'not-an-id')).toBeNull();
    });
  });

  describe('streamAuditLogEntries', () => {
    it('streams all matching rows newest-first', async () => {
      await seed(3);
      const seen: number[] = [];
      const { count, truncated } = await methods.streamAuditLogEntries('tenant-a', {}, (e) => {
        seen.push(e.integrity.seq);
      });
      expect(count).toBe(3);
      expect(truncated).toBe(false);
      expect(seen).toEqual([3, 2, 1]);
    });

    it('honors isCancelled and reports truncation only when the cap cuts rows off', async () => {
      await seed(5);
      const cancelled = await methods.streamAuditLogEntries('tenant-a', {}, () => {}, {
        isCancelled: () => true,
      });
      expect(cancelled.count).toBe(0);

      const capped = await methods.streamAuditLogEntries('tenant-a', {}, () => {}, { maxRows: 2 });
      expect(capped.count).toBe(2);
      expect(capped.truncated).toBe(true);

      // exact-cap match exhausts naturally and is NOT truncated
      const exact = await methods.streamAuditLogEntries('tenant-a', {}, () => {}, { maxRows: 5 });
      expect(exact.count).toBe(5);
      expect(exact.truncated).toBe(false);
    });
  });

  describe('verifyAuditChain', () => {
    it('verifies an intact chain', async () => {
      await seed(4);
      const result = await methods.verifyAuditChain('tenant-a');
      expect(result.ok).toBe(true);
      expect(result.checked).toBe(4);
      expect(result.range).toEqual({ firstSeq: 1, lastSeq: 4 });
    });

    it('reports ok for an empty chain', async () => {
      const result = await methods.verifyAuditChain('tenant-a');
      expect(result.ok).toBe(true);
      expect(result.checked).toBe(0);
    });

    it('stops verification when the caller cancels', async () => {
      await seed(3);
      const result = await methods.verifyAuditChain('tenant-a', { isCancelled: () => true });
      expect(result.ok).toBe(false);
      expect(result.checked).toBe(0);
      expect(result.reason).toBe('verification cancelled');
    });

    it('bounds verification when rows exceed the configured cap', async () => {
      await seed(3);
      const result = await methods.verifyAuditChain('tenant-a', { maxRows: 2 });
      expect(result.ok).toBe(false);
      expect(result.checked).toBe(2);
      expect(result.brokenAt).toBe(3);
      expect(result.reason).toMatch(/row limit exceeded/);
    });

    it('allows an exact-cap verification to complete', async () => {
      await seed(2);
      const result = await methods.verifyAuditChain('tenant-a', { maxRows: 2 });
      expect(result.ok).toBe(true);
      expect(result.checked).toBe(2);
    });

    it('detects a tampered field (hash mismatch)', async () => {
      await seed(3);
      // mutate a field via the raw driver, bypassing the append-only hooks
      await AuditLog.collection.updateOne(
        { chainKey: CK_A, seq: 2 },
        { $set: { 'actor.name': 'Mallory' } },
      );
      const result = await methods.verifyAuditChain('tenant-a');
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toBe('hash mismatch');
    });

    it('detects a deleted entry (sequence gap)', async () => {
      await seed(3);
      await AuditLog.collection.deleteOne({ chainKey: CK_A, seq: 2 });
      const result = await methods.verifyAuditChain('tenant-a');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/sequence gap/);
    });

    it('detects a forged hash link', async () => {
      await seed(3);
      await AuditLog.collection.updateOne(
        { chainKey: CK_A, seq: 2 },
        { $set: { hash: 'f'.repeat(64) } },
      );
      const result = await methods.verifyAuditChain('tenant-a');
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it('does not silently trust a deleted prefix without a checkpoint', async () => {
      await seed(3);
      // attacker deletes the oldest row through the raw driver
      await AuditLog.collection.deleteOne({ chainKey: CK_A, seq: 1 });
      const result = await methods.verifyAuditChain('tenant-a');
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toMatch(/non-genesis|prefix/);
    });

    it('rejects a checkpoint that does not match the remaining chain', async () => {
      await seed(3);
      await AuditLog.collection.deleteOne({ chainKey: CK_A, seq: 1 });
      const result = await methods.verifyAuditChain('tenant-a', {
        trustedCheckpoint: { throughSeq: 1, prevHash: 'f'.repeat(64) },
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/checkpoint mismatch/);
    });
  });

  describe('purgeAuditLogEntries', () => {
    it('is a no-op unless confirmed', async () => {
      await seed(2);
      const result = await methods.purgeAuditLogEntries('tenant-a', {
        before: new Date(Date.now() + 60_000),
        confirm: false,
      });
      expect(result.deletedCount).toBe(0);
      expect(await AuditLog.countDocuments({ chainKey: CK_A })).toBe(2);
    });

    it('purges a prefix and leaves the chain verifiable from a checkpoint', async () => {
      // space writes so createdAt is strictly increasing for a deterministic cutoff
      for (let i = 0; i < 4; i++) {
        await methods.recordAuditEntry(baseInput());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const third = await AuditLog.findOne({ chainKey: CK_A, seq: 3 }).lean();
      const cutoff = third!.createdAt;

      const result = await methods.purgeAuditLogEntries('tenant-a', {
        before: cutoff,
        confirm: true,
      });
      expect(result.deletedCount).toBeGreaterThanOrEqual(1);
      expect(result.checkpoint?.throughSeq).toBeGreaterThanOrEqual(1);

      // Without the checkpoint, the now non-genesis start is flagged, not trusted.
      const unverified = await methods.verifyAuditChain('tenant-a');
      expect(unverified.ok).toBe(false);

      // With the checkpoint the purge returned, the shorter chain verifies.
      const verified = await methods.verifyAuditChain('tenant-a', {
        trustedCheckpoint: result.checkpoint,
      });
      expect(verified.ok).toBe(true);
      expect(verified.range?.firstSeq).toBeGreaterThan(1);
    });

    it('purges only a contiguous seq prefix under createdAt clock skew', async () => {
      for (let i = 0; i < 4; i++) {
        await methods.recordAuditEntry(baseInput());
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const fourth = await AuditLog.findOne({ chainKey: CK_A, seq: 4 }).lean();
      // simulate multi-instance clock skew: the earliest seq carries a late timestamp
      await AuditLog.collection.updateOne(
        { chainKey: CK_A, seq: 1 },
        { $set: { createdAt: new Date(fourth!.createdAt.getTime() + 60_000) } },
      );
      // a naive `createdAt < before` delete would drop interior rows (seq 2 & 3)
      // while keeping seq 1, creating a gap — the seq-boundary purge must refuse,
      // since seq 1 (the lowest seq) is now within the retention window.
      const result = await methods.purgeAuditLogEntries('tenant-a', {
        before: fourth!.createdAt,
        confirm: true,
      });
      expect(result.deletedCount).toBe(0);
      const remaining = await AuditLog.find({ chainKey: CK_A })
        .sort({ seq: 1 })
        .select('seq')
        .lean<{ seq: number }[]>();
      expect(remaining.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    });

    it('does not mint a checkpoint when a confirmed purge removed nothing', async () => {
      await seed(2);
      const result = await methods.purgeAuditLogEntries('tenant-a', {
        // cutoff before every entry → nothing matches → no authorized prefix
        before: new Date(Date.now() - 60_000),
        confirm: true,
      });
      expect(result.deletedCount).toBe(0);
      expect(result.checkpoint).toBeUndefined();
    });
  });

  describe('append index safety', () => {
    it('fails open within the index-build deadline while a peer holds the collection', async () => {
      const prototype = mongoose.mongo.Collection.prototype;
      const createIndex = prototype.createIndex;
      const collectionName = AuditLog.collection.name;
      prototype.createIndex = async function (this: mongoose.mongo.Collection, spec, options) {
        if (this.collectionName !== collectionName) {
          return createIndex.call(this, spec, options);
        }
        throw new mongoose.mongo.MongoServerError({
          ok: 0,
          code: 40333,
          errmsg:
            'Existing index build in progress on the same collection. Collection is limited to a single index build at a time.',
        });
      };
      try {
        const freshMethods = createAuditLogMethods(mongoose, {
          indexBuild: { peerBuildPollMs: 1, peerBuildDeadlineMs: 20 },
        });

        await expect(freshMethods.recordAuditEntry(baseInput())).resolves.toBeNull();
      } finally {
        prototype.createIndex = createIndex;
      }
    });

    it('builds the unique seq index before appending (independent of autoIndex)', async () => {
      const spy = jest.spyOn(AuditLog, 'createIndexes');
      // a fresh methods instance has not yet memoized the index build
      const freshMethods = createAuditLogMethods(mongoose);
      await freshMethods.recordAuditEntry(baseInput());
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
