import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { BrowserSetupSession, BrowserSetupStore } from '~/types/browserSetup';
import { createBrowserSetupStore } from './browserSetup';

const now = Date.parse('2026-10-22T10:00:00.000Z');
const limits = { global: 4, perIp: 2, windowMs: 60_000 };
const hash = (input: string): string => createHash('sha256').update(input).digest('hex');
const ipHash = hash('trusted-request-ip');
function session(attemptId: string): BrowserSetupSession {
  const requestCanonical = JSON.stringify({ attemptId, machineName: 'Machine' });
  return {
    attemptId,
    requestCanonical,
    requestHash: hash(requestCanonical),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
    verificationCode: 'ABCD-1234',
    workerId: `worker-${attemptId}`,
    status: 'pending',
    revision: 0,
  };
}

function persistedSessions() {
  return mongoose.connection.db!.collection<{
    _id: string;
    nonces: Array<{ nonce: string; expiresAt: number }>;
    operations: number;
    deleteAfter?: Date;
  }>('browser_setup_sessions');
}

function allocationBudget() {
  return mongoose.connection.db!.collection<{
    _id: string;
    allocations: Array<{ session: BrowserSetupSession }>;
  }>('browser_setup_budget');
}

function requestBudget() {
  return mongoose.connection.db!.collection<{
    _id: string;
    count: number;
    peers: Record<string, number>;
  }>('browser_setup_requests');
}

describe('durable browser setup store', () => {
  let mongo: MongoMemoryServer;
  let store: BrowserSetupStore;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
  });
  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    store = createBrowserSetupStore(mongoose);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  test('constructing a store does not launch database work outside an awaited boundary', async () => {
    const createIndex = jest.spyOn(mongoose.mongo.Collection.prototype, 'createIndex');
    try {
      const fresh = createBrowserSetupStore(mongoose);
      expect(createIndex).not.toHaveBeenCalled();
      await fresh.get('missing');
      expect(createIndex).toHaveBeenCalledTimes(2);
    } finally {
      createIndex.mockRestore();
    }
  });

  test('concurrent start preserves the first immutable session and survives factory recreation', async () => {
    const original = session('attempt');
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.start({
          session: { ...original, verificationCode: `code-${index}` },
          ipHash,
          now,
          limits,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
    const persisted = await createBrowserSetupStore(mongoose).get(original.attemptId);
    expect(persisted).toMatchObject({ ...original, verificationCode: expect.any(String) });
    for (const result of results) {
      expect(['created', 'replay']).toContain(result.status);
      if ('session' in result) expect(result.session).toEqual(persisted);
    }
    const altered = {
      ...original,
      requestCanonical: '{"different":true}',
      requestHash: hash('{"different":true}'),
    };
    await expect(store.start({ session: altered, ipHash, now, limits })).resolves.toEqual({
      status: 'conflict',
    });
  });

  test('CAS and write-once frozen fields reject conflicting owners and immutable patches', async () => {
    const original = session('cas');
    await store.start({ session: original, ipHash, now, limits });
    const race = await Promise.all(
      ['owner-one', 'owner-two'].map((ownerId) =>
        store.update({
          attemptId: original.attemptId,
          requestHash: original.requestHash,
          revision: 0,
          patch: { ownerId, tenantId: 'tenant-a', status: 'provisioning' },
        }),
      ),
    );
    expect(race.filter(Boolean)).toHaveLength(1);
    const frozen = race.find((entry) => entry != null)!;
    await expect(
      store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: frozen.revision,
        patch: { tenantId: 'tenant-b' },
      }),
    ).resolves.toBeNull();
    await expect(
      store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: frozen.revision,
        patch: { ownerId: undefined },
      }),
    ).rejects.toThrow('Invalid frozen');
    await expect(
      store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: frozen.revision,
        patch: { workerId: 'replacement' } as never,
      }),
    ).rejects.toThrow('Invalid browser setup update');
  });

  test('leases are exclusive, revision-fenced, durable, and reclaimable after expiry', async () => {
    const original = session('lease');
    await store.start({ session: original, ipHash, now, limits });
    const claims = await Promise.all(
      ['lease-a', 'lease-b'].map((leaseId) =>
        store.claim({
          attemptId: original.attemptId,
          requestHash: original.requestHash,
          revision: 0,
          leaseId,
          now,
          leaseMs: 60_000,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = claims.find((entry) => entry != null)!;
    expect(await store.listReconcile(10, now)).toEqual([]);
    await expect(
      store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: claimed.revision,
        patch: { status: 'provisioning' },
      }),
    ).resolves.toBeNull();
    const next = await createBrowserSetupStore(mongoose).claim({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: claimed.revision,
      leaseId: 'successor',
      now: now + 60_001,
      leaseMs: 60_000,
    });
    expect(next?.revision).toBe(claimed.revision + 1);
    await expect(
      store.release({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: claimed.revision,
        leaseId: claimed.leaseId!,
      }),
    ).resolves.toBeNull();
    expect(
      await store.release({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: next!.revision,
        leaseId: 'successor',
      }),
    ).toMatchObject({ revision: next!.revision + 1 });
    expect(await store.listReconcile(1, now + 60_002)).toHaveLength(0);
    expect(await store.listReconcile(1, now + 600_002)).toHaveLength(1);
  });

  test('nonces are shared, bounded, replay-safe, and operation counts survive nonce pruning', async () => {
    const original = session('nonce');
    await store.start({ session: original, ipHash, now, limits });
    const input = {
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      nonce: 'nonce-a',
      now,
      expiresAt: now + 1000,
      maxNonces: 1,
      maxOperations: 2,
    };
    const results = await Promise.all([
      store.claimNonce(input),
      createBrowserSetupStore(mongoose).claimNonce(input),
    ]);
    expect(results.sort()).toEqual(['claimed', 'replay']);
    await expect(store.claimNonce({ ...input, nonce: 'nonce-b' })).resolves.toBe('limited');
    await expect(
      store.claimNonce({ ...input, nonce: 'nonce-b', now: now + 1001, expiresAt: now + 2000 }),
    ).resolves.toBe('claimed');
    await expect(
      store.claimNonce({ ...input, nonce: 'nonce-c', now: now + 2001, expiresAt: now + 3000 }),
    ).resolves.toBe('limited');
    await expect(store.claimNonce({ ...input, requestHash: hash('wrong') })).resolves.toBe(
      'missing',
    );
    const persisted = await persistedSessions().findOne({ _id: original.attemptId });
    expect(persisted?.nonces).toHaveLength(1);
    expect(persisted?.operations).toBe(2);
  });

  test('global and per-IP occupancy stay bounded across windows and release only after terminal cleanup', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.start({
          session: session(`slot-${index}`),
          ipHash: hash(`peer-${index % 3}`),
          now,
          limits,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(limits.global);
    const created = results.filter(
      (result): result is Extract<typeof result, { session: BrowserSetupSession }> =>
        'session' in result,
    );
    const owned = created[0].session;
    await store.update({
      attemptId: owned.attemptId,
      requestHash: owned.requestHash,
      revision: 0,
      patch: { ownerId: 'owner', status: 'provisioning' },
    });
    await expect(
      store.start({ session: session('later'), ipHash, now: now + 86_400_000, limits }),
    ).resolves.toEqual({ status: 'limited' });
    await expect(
      store.update({
        attemptId: owned.attemptId,
        requestHash: owned.requestHash,
        revision: 1,
        patch: { purgeAt: new Date(now).toISOString() },
      }),
    ).rejects.toThrow('Unresolved');
    const unresolved = await persistedSessions().findOne({ _id: owned.attemptId });
    expect(unresolved?.deleteAfter).toBeUndefined();
    await store.update({
      attemptId: owned.attemptId,
      requestHash: owned.requestHash,
      revision: 1,
      patch: {
        status: 'cancelled',
        progress: { cleanup: true },
        purgeAt: new Date(now + 1000).toISOString(),
      },
    });
    await expect(
      store.start({ session: session('later'), ipHash, now: now + 86_400_000, limits }),
    ).resolves.toMatchObject({ status: 'created' });
    const resolved = await persistedSessions().findOne({ _id: owned.attemptId });
    expect(resolved?.deleteAfter).toEqual(new Date(now + 1000));
    expect(await store.listReconcile(2, now + 86_400_000)).toHaveLength(2);
  });

  test('pre-proof request limits atomically bound global and per-IP state', async () => {
    const samePeer = await Promise.all(
      Array.from({ length: 12 }, () => store.consumeRequest({ ipHash, now, limits })),
    );
    expect(samePeer.filter(Boolean)).toHaveLength(limits.perIp);
    const diverse = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.consumeRequest({ ipHash: hash(`untrusted-${index}`), now, limits }),
      ),
    );
    expect(diverse.filter(Boolean)).toHaveLength(limits.global - limits.perIp);
    const budget = await requestBudget().findOne({ _id: 'global' });
    expect(budget?.count).toBe(limits.global);
    expect(Object.keys(budget?.peers ?? {}).length).toBeLessThanOrEqual(limits.global);
    expect(await requestBudget().countDocuments()).toBe(1);
    expect(
      await createBrowserSetupStore(mongoose).consumeRequest({
        ipHash,
        now: now + limits.windowMs,
        limits,
      }),
    ).toBe(true);
    const reset = await requestBudget().findOne({ _id: 'global' });
    expect(reset?.peers).toEqual({ [ipHash]: 1 });
  });

  test('allocation per-IP bound is atomic under racing starts', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.start({ session: session(`same-${index}`), ipHash, now, limits }),
      ),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(limits.perIp);
  });
  test('an expired lease holder cannot save even before a successor acquires the lease', async () => {
    const original = session('expired-holder');
    await store.start({ session: original, ipHash, now, limits });
    const claimed = await store.claim({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: 0,
      leaseId: 'expired',
      now,
      leaseMs: 1,
    });
    await expect(
      store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: claimed!.revision,
        leaseId: 'expired',
        patch: { status: 'provisioning' },
      }),
    ).resolves.toBeNull();
  });

  test('completed withdrawal disarms TTL until compensation finishes and cannot reopen completion', async () => {
    const original = session('withdrawal');
    const clock = Date.now();
    await store.start({ session: original, ipHash, now, limits });
    const completed = await store.update({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: 0,
      patch: {
        status: 'completed',
        tenantId: '',
        stopReason: 'expired',
        progress: { cleanup: true },
        purgeAt: new Date(clock + 60_000).toISOString(),
      },
    });
    expect(completed?.tenantId).toBe('');
    expect(await store.listReconcile(10, clock)).toEqual([]);
    const claimed = await store.claim({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: completed!.revision,
      leaseId: 'withdrawal',
      now: clock,
      leaseMs: 60_000,
    });
    const withdrawn = await store.update({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: claimed!.revision,
      leaseId: 'withdrawal',
      patch: { stopReason: 'withdrawn' },
    });
    expect(withdrawn?.progress?.cleanup).toBe(false);
    const persisted = await persistedSessions().findOne({ _id: original.attemptId });
    expect(persisted?.deleteAfter).toBeUndefined();
    await expect(
      store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: withdrawn!.revision,
        leaseId: 'withdrawal',
        patch: { status: 'approved' },
      }),
    ).resolves.toBeNull();
    await expect(
      store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: withdrawn!.revision,
        leaseId: 'withdrawal',
        patch: { stopReason: 'cancelled' },
      }),
    ).resolves.toBeNull();
    const failed = await store.update({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: withdrawn!.revision,
      leaseId: 'withdrawal',
      patch: {
        status: 'failed',
        progress: { cleanup: true },
        purgeAt: new Date(clock + 120_000).toISOString(),
      },
    });
    await store.release({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: failed!.revision,
      leaseId: 'withdrawal',
    });
    const resolved = await persistedSessions().findOne({ _id: original.attemptId });
    expect(resolved?.deleteAfter).toEqual(new Date(clock + 120_000));
  });

  test('live pending attempts do not starve provisioning, and repeated failures rotate behind other work', async () => {
    const records = [
      session('pending-a'),
      session('pending-b'),
      session('provision-a'),
      session('provision-b'),
    ];
    for (let index = 0; index < records.length; index++)
      await store.start({ session: records[index], ipHash: hash(`fair-${index}`), now, limits });
    for (const original of records.slice(2))
      await store.update({
        attemptId: original.attemptId,
        requestHash: original.requestHash,
        revision: 0,
        patch: { ownerId: 'owner', status: 'provisioning' },
      });
    const first = (await store.listReconcile(1, now))[0];
    expect(first.attemptId.startsWith('provision-')).toBe(true);
    const claimed = await store.claim({
      attemptId: first.attemptId,
      requestHash: first.requestHash,
      revision: first.revision,
      leaseId: 'fairness',
      now,
      leaseMs: 60_000,
    });
    await store.release({
      attemptId: first.attemptId,
      requestHash: first.requestHash,
      revision: claimed!.revision,
      leaseId: 'fairness',
    });
    const second = (await store.listReconcile(1, now + 1))[0];
    expect(second.attemptId.startsWith('provision-')).toBe(true);
    expect(second.attemptId).not.toBe(first.attemptId);
  });
  test('a lost session insert reuses the durable allocation snapshot rather than new retry randomness', async () => {
    const original = session('insert-loss');
    await store.start({ session: original, ipHash, now, limits });
    await persistedSessions().deleteOne({ _id: original.attemptId });
    const recovered = await createBrowserSetupStore(mongoose).start({
      session: { ...original, verificationCode: 'new-code' },
      ipHash,
      now,
      limits,
    });
    expect(recovered).toEqual({ status: 'created', session: original });
    const budget = await allocationBudget().findOne({ _id: 'global' });
    expect(budget?.allocations).toHaveLength(1);
  });

  test('a database outage is an error, never an in-memory success or absence', async () => {
    const original = session('outage');
    await store.start({ session: original, ipHash, now, limits });
    await mongoose.disconnect();
    try {
      await expect(store.get(original.attemptId)).rejects.toThrow();
    } finally {
      await mongoose.connect(mongo.getUri());
    }
  });
  test('reconciliation recovers an abandoned allocation snapshot without a client retry', async () => {
    const original = session('abandoned-insert');
    await store.start({ session: original, ipHash, now, limits });
    await persistedSessions().deleteOne({ _id: original.attemptId });
    const recovered = await createBrowserSetupStore(mongoose).listReconcile(1, now + 600_001);
    expect(recovered).toEqual([original]);
    await store.update({
      attemptId: original.attemptId,
      requestHash: original.requestHash,
      revision: 0,
      patch: { status: 'expired', progress: { cleanup: true } },
    });
    const budget = await allocationBudget().findOne({ _id: 'global' });
    expect(budget?.allocations).toEqual([]);
  });
});
