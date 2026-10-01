import Keyv from 'keyv';

import type { LockableCache } from '~/cache/lock';
import { ImportJobStore } from './job';

/**
 * A job store shared between replicas, i.e. the Redis-backed namespace the
 * server actually runs on. The `Map` stands in for Redis' keyspace and
 * `acquireLock` for its `SET NX`: both settle synchronously before any
 * `await`, which is the one property of the real command these tests depend
 * on. Every job read and write still goes through a single real `Keyv`, so
 * the racing reads under test are the genuine article.
 */
function sharedJobStore(lockTtl = 60000): LockableCache {
  const store = new Keyv() as LockableCache;
  const claims = new Map<string, string>();
  const expirations = new Map<string, number>();
  let issued = 0;

  store.acquireLock = async (key) => {
    if ((expirations.get(key) ?? 0) <= Date.now()) {
      claims.delete(key);
      expirations.delete(key);
    }
    if (claims.has(key)) {
      return null;
    }
    const token = `claim-${(issued += 1)}`;
    claims.set(key, token);
    expirations.set(key, Date.now() + lockTtl);
    return token;
  };
  store.extendLock = async (key, token) => {
    if (claims.get(key) !== token || (expirations.get(key) ?? 0) <= Date.now()) {
      return false;
    }
    expirations.set(key, Date.now() + lockTtl);
    return true;
  };
  store.releaseLock = async (key, token) => {
    if (claims.get(key) === token) {
      claims.delete(key);
      expirations.delete(key);
    }
  };
  store.setIfLockOwned = async (lockKey, key, token, value, ttl) => {
    if (claims.get(lockKey) !== token || (expirations.get(lockKey) ?? 0) <= Date.now()) {
      return false;
    }
    await store.set(key, value, ttl);
    return true;
  };
  store.lockTtl = lockTtl;

  return store;
}

/** Stalls the next read of the backing store, so a second caller can complete
 * a whole transition inside the window the first one is holding open. */
function stallNextRead(store: Keyv, ms: number): void {
  const read = store.get.bind(store);
  let stall = true;
  jest.spyOn(store, 'get').mockImplementation((async (key: string) => {
    const value = await read(key);
    if (stall) {
      stall = false;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return value;
  }) as typeof store.get);
}

/** Stops one backing-store write after the mutation's final read. This gates
 * the exact stale-snapshot window between `applyPatch` and `store.set`. */
function gateNextWrite(store: Keyv): { writing: Promise<void>; release: () => void } {
  const write = store.set.bind(store);
  let releaseWrite: () => void = () => undefined;
  let announceWrite: () => void = () => undefined;
  const writing = new Promise<void>((resolve) => {
    announceWrite = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let gate = true;
  jest.spyOn(store, 'set').mockImplementation((async (...args: Parameters<typeof store.set>) => {
    if (gate) {
      gate = false;
      announceWrite();
      await released;
    }
    return write(...args);
  }) as typeof store.set);
  return { writing, release: releaseWrite };
}

describe('ImportJobStore', () => {
  let store: ImportJobStore;

  beforeEach(() => {
    store = new ImportJobStore(new Keyv(), 60000);
  });

  it('creates a job awaiting confirmation', async () => {
    const job = await store.create({
      userId: 'u1',
      filepath: '/tmp/a.zip',
      filename: 'a.zip',
    });

    expect(job.phase).toBe('queued');
    expect(job.status).toBe('active');
    expect(job.jobId).toHaveLength(36);
    expect(job.progress).toEqual({
      conversations: { done: 0, total: 0 },
      messages: { done: 0, total: 0 },
      assets: { done: 0, total: 0 },
    });
  });

  it('reads back a job for its owner only', async () => {
    const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });

    expect(await store.get('u1', job.jobId)).not.toBeNull();
    expect(await store.get('u2', job.jobId)).toBeNull();
  });

  it('merges patches and bumps updatedAt', async () => {
    const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });

    const patched = await store.patch('u1', job.jobId, {
      phase: 'conversations',
      progress: {
        conversations: { done: 5, total: 10 },
        messages: { done: 40, total: 80 },
        assets: { done: 0, total: 3 },
      },
    });

    expect(patched?.phase).toBe('conversations');
    expect(patched?.progress.conversations.done).toBe(5);
    expect(patched?.filename).toBe('a.zip');
    expect(patched?.updatedAt).toBeGreaterThanOrEqual(job.updatedAt);
  });

  it('marks a job cancelled and reports it', async () => {
    const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });

    expect(await store.isCancelled('u1', job.jobId)).toBe(false);
    expect(await store.cancel('u1', job.jobId)).toEqual({
      status: 'cancelled',
      previousPhase: 'queued',
    });
    expect(await store.isCancelled('u1', job.jobId)).toBe(true);
    expect((await store.get('u1', job.jobId))?.status).toBe('cancelled');
  });

  it('does not cancel another user’s job', async () => {
    const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
    expect(await store.cancel('u2', job.jobId)).toEqual({
      status: 'not_found',
      previousPhase: null,
    });
    expect((await store.get('u1', job.jobId))?.status).toBe('active');
  });

  it('returns null when patching a job that does not exist', async () => {
    expect(await store.patch('u1', 'missing', { phase: 'failed' })).toBeNull();
  });

  it('keeps identity fields matching the storage key after a patch', async () => {
    const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });

    const patched = await store.patch('u1', job.jobId, { phase: 'assets' });

    expect(patched?.userId).toBe('u1');
    expect(patched?.jobId).toBe(job.jobId);
  });

  it('does not report another user’s job as cancelled', async () => {
    const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
    await store.cancel('u1', job.jobId);

    expect(await store.isCancelled('u2', job.jobId)).toBe(false);
  });

  it('does not patch another user’s job and leaves the owner’s record untouched', async () => {
    const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });

    const result = await store.patch('u2', job.jobId, { phase: 'assets', status: 'failed' });

    expect(result).toBeNull();
    const owned = await store.get('u1', job.jobId);
    expect(owned?.phase).toBe(job.phase);
    expect(owned?.status).toBe(job.status);
    expect(owned?.updatedAt).toBe(job.updatedAt);
  });

  describe('terminal jobs', () => {
    it('ignores a phase update that lands after cancellation', async () => {
      const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
      await store.cancel('u1', job.jobId);

      const patched = await store.patch('u1', job.jobId, { phase: 'conversations' });

      expect(patched?.phase).toBe('cancelled');
      expect(patched?.status).toBe('cancelled');
      expect(await store.isCancelled('u1', job.jobId)).toBe(true);
    });

    it('still records the partial report a cancelled run produced', async () => {
      const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
      await store.cancel('u1', job.jobId);

      const report = {
        imported: 12,
        skipped: 0,
        assetsImported: 3,
        assetsUnavailable: 0,
        errors: [],
      };
      const patched = await store.patch('u1', job.jobId, { report });

      expect(patched?.report).toEqual(report);
      expect(patched?.phase).toBe('cancelled');
    });

    /** The background run reads the cancel flag and writes progress in two
     * separate round trips. Without serialization the progress write lands on a
     * job it read before the cancellation, resurrecting `status: 'active'`,
     * and the very next `isCancelled` then tells the run to keep importing. */
    it('does not let a progress update in flight during a cancellation resurrect the job', async () => {
      const backing = new Keyv();
      /** Only the first read stalls, which is the progress update's: the
       * cancellation then reads and writes entirely inside that window, so the
       * progress write is left holding a job snapshot taken before it. */
      stallNextRead(backing, 20);
      const slowStore = new ImportJobStore(backing, 60000);
      const job = await slowStore.create({
        userId: 'u1',
        filepath: '/tmp/a.zip',
        filename: 'a.zip',
      });

      const progress = slowStore.patch('u1', job.jobId, {
        progress: {
          conversations: { done: 5, total: 10 },
          messages: { done: 40, total: 80 },
          assets: { done: 0, total: 0 },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      await slowStore.cancel('u1', job.jobId);
      await progress;

      expect(await slowStore.isCancelled('u1', job.jobId)).toBe(true);
    });
  });

  describe('confirmStart', () => {
    it('returns not_found for a job that does not exist', async () => {
      expect(await store.confirmStart('u1', 'missing')).toEqual({ status: 'not_found' });
    });

    it('rejects a start for a job not yet awaiting confirmation', async () => {
      const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });

      const result = await store.confirmStart('u1', job.jobId);

      expect(result.status).toBe('conflict');
    });

    it('moves an awaiting_confirmation job to queued and returns it', async () => {
      const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
      await store.patch('u1', job.jobId, { phase: 'awaiting_confirmation' });

      const result = await store.confirmStart('u1', job.jobId);

      expect(result).toMatchObject({ status: 'started', job: { phase: 'queued' } });
    });

    it('does not confirm start for another user’s job', async () => {
      const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
      await store.patch('u1', job.jobId, { phase: 'awaiting_confirmation' });

      expect(await store.confirmStart('u2', job.jobId)).toEqual({ status: 'not_found' });
      const owned = await store.get('u1', job.jobId);
      expect(owned?.phase).toBe('awaiting_confirmation');
    });

    it('allows only one of two racing calls to start the same job', async () => {
      const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
      await store.patch('u1', job.jobId, { phase: 'awaiting_confirmation' });

      const [first, second] = await Promise.all([
        store.confirmStart('u1', job.jobId),
        store.confirmStart('u1', job.jobId),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual(['conflict', 'started']);
    });

    /**
     * Two replicas behind one shared job store. Each has its own transition
     * lock, so the in-process serialization above says nothing here: both read
     * `awaiting_confirmation` before either write lands, and `importedFrom` is
     * not a unique index, so a second run duplicates every conversation the
     * first has not yet committed.
     */
    describe('across replicas', () => {
      let backing: LockableCache;
      let replicaA: ImportJobStore;
      let replicaB: ImportJobStore;

      beforeEach(() => {
        backing = sharedJobStore();
        replicaA = new ImportJobStore(backing, 60000);
        replicaB = new ImportJobStore(backing, 60000);
      });

      async function awaitingJob(): Promise<string> {
        const job = await replicaA.create({
          userId: 'u1',
          filepath: '/tmp/a.zip',
          filename: 'a.zip',
        });
        await replicaA.patch('u1', job.jobId, { phase: 'awaiting_confirmation' });
        return job.jobId;
      }

      it('lets only one of two replicas start the same job', async () => {
        const jobId = await awaitingJob();

        const [first, second] = await Promise.all([
          replicaA.confirmStart('u1', jobId),
          replicaB.confirmStart('u1', jobId),
        ]);

        expect([first.status, second.status].sort()).toEqual(['conflict', 'started']);
        expect((await replicaB.get('u1', jobId))?.phase).toBe('queued');
      });

      it('refuses the replica that lost the claim even while the winner is still writing', async () => {
        const jobId = await awaitingJob();
        /** The winner's own read stalls, so the loser answers from inside the
         * window where the job is still `awaiting_confirmation` on the store. */
        stallNextRead(backing, 20);

        const winner = replicaA.confirmStart('u1', jobId);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const loser = await replicaB.confirmStart('u1', jobId);

        expect(loser.status).toBe('conflict');
        expect(await winner).toMatchObject({ status: 'started', job: { phase: 'queued' } });
      });

      it('hands the claim back so a later start still sees the job as already started', async () => {
        const jobId = await awaitingJob();
        await replicaA.confirmStart('u1', jobId);

        const replay = await replicaB.confirmStart('u1', jobId);

        expect(replay).toMatchObject({ status: 'conflict', job: { phase: 'queued' } });
      });

      it('returns a retryable result while another replica still holds the claim', async () => {
        backing.acquireLock = async () => null;

        expect(await replicaA.confirmStart('u1', 'missing')).toEqual({
          status: 'lock_unavailable',
        });
      });

      it('serializes cancellation after the confirmation final read without overwriting it', async () => {
        const jobId = await awaitingJob();
        const gate = gateNextWrite(backing);

        const confirming = replicaA.confirmStart('u1', jobId);
        await gate.writing;
        const cancelling = replicaB.cancel('u1', jobId);
        gate.release();
        const [started, cancelled] = await Promise.all([confirming, cancelling]);

        expect(started).toMatchObject({ status: 'started', job: { phase: 'queued' } });
        expect(cancelled).toEqual({ status: 'cancelled', previousPhase: 'queued' });
        expect(await replicaA.isCancelled('u1', jobId)).toBe(true);
        expect((await replicaA.get('u1', jobId))?.phase).toBe('cancelled');
      });

      it('renews the claim while a slow mutation outlives its original lease', async () => {
        backing = sharedJobStore(30);
        replicaA = new ImportJobStore(backing, 60000);
        replicaB = new ImportJobStore(backing, 60000);
        const jobId = await awaitingJob();
        const gate = gateNextWrite(backing);

        const confirming = replicaA.confirmStart('u1', jobId);
        await gate.writing;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const cancelling = replicaB.cancel('u1', jobId);
        gate.release();
        const [started, cancelled] = await Promise.all([confirming, cancelling]);

        expect(started).toMatchObject({ status: 'started', job: { phase: 'queued' } });
        expect(cancelled).toEqual({ status: 'cancelled', previousPhase: 'queued' });
        expect((await replicaA.get('u1', jobId))?.status).toBe('cancelled');
      });

      it('waits for an in-flight renewal before writing under the claim', async () => {
        backing = sharedJobStore(100);
        replicaA = new ImportJobStore(backing, 60000);
        const jobId = await awaitingJob();

        let announceRenewal: () => void = () => undefined;
        let releaseRenewal: () => void = () => undefined;
        const renewalStarted = new Promise<void>((resolve) => {
          announceRenewal = resolve;
        });
        const renewalReleased = new Promise<void>((resolve) => {
          releaseRenewal = resolve;
        });
        jest.spyOn(backing, 'extendLock').mockImplementationOnce(async () => {
          announceRenewal();
          await renewalReleased;
          return true;
        });
        stallNextRead(backing, 40);
        const writeGate = gateNextWrite(backing);
        let writeStarted = false;
        void writeGate.writing.then(() => {
          writeStarted = true;
        });

        const confirming = replicaA.confirmStart('u1', jobId);
        await renewalStarted;
        await new Promise((resolve) => setImmediate(resolve));

        expect(writeStarted).toBe(false);

        releaseRenewal();
        await writeGate.writing;
        writeGate.release();

        await expect(confirming).resolves.toMatchObject({ status: 'started' });
      });

      it('makes cancellation retryable when the shared claim cannot be taken', async () => {
        const jobId = await awaitingJob();
        backing.acquireLock = async () => {
          throw new Error('Redis unavailable');
        };

        expect(await replicaA.cancel('u1', jobId)).toEqual({
          status: 'lock_unavailable',
          previousPhase: null,
        });
        expect((await replicaA.get('u1', jobId))?.phase).toBe('awaiting_confirmation');
      });

      it('returns from a best-effort progress patch when the shared claim is unavailable', async () => {
        const jobId = await awaitingJob();
        backing.acquireLock = async () => {
          throw new Error('Redis unavailable');
        };

        await expect(
          replicaA.patchProgress('u1', jobId, {
            conversations: { done: 1, total: 2 },
            messages: { done: 3, total: 4 },
            assets: { done: 5, total: 6 },
          }),
        ).resolves.toBeNull();
        expect((await replicaA.get('u1', jobId))?.progress).toEqual({
          conversations: { done: 0, total: 0 },
          messages: { done: 0, total: 0 },
          assets: { done: 0, total: 0 },
        });
      });
      it('rejects a required patch after bounded claim retries', async () => {
        const jobId = await awaitingJob();
        let attempts = 0;
        backing.acquireLock = async () => {
          attempts += 1;
          throw new Error('Redis unavailable');
        };

        await expect(
          replicaA.patch('u1', jobId, {
            phase: 'conversations',
          }),
        ).rejects.toThrow('Redis unavailable');
        expect(attempts).toBeLessThanOrEqual(3);
      });

      it('does not write when the atomic commit reports that ownership was lost', async () => {
        const jobId = await awaitingJob();
        jest.spyOn(backing, 'setIfLockOwned').mockResolvedValueOnce(false);

        const result = await replicaA.confirmStart('u1', jobId);

        expect(result).toEqual({ status: 'lock_unavailable' });
        expect((await replicaA.get('u1', jobId))?.phase).toBe('awaiting_confirmation');
      });

      /**
       * A store that raises on the claim cannot tell this replica whether
       * another one is confirming the same job right now, and `importedFrom`
       * is not a unique index, so starting anyway would put the duplicate-run
       * race back for as long as the store stays degraded. Refusing is the
       * fail-closed answer, and it costs nothing: the job is untouched.
       */
      it('refuses to start the job when the claim cannot be taken', async () => {
        const jobId = await awaitingJob();
        backing.acquireLock = async () => {
          throw new Error('Redis unavailable');
        };

        const result = await replicaA.confirmStart('u1', jobId);

        expect(result).toEqual({ status: 'lock_unavailable' });
        expect((await replicaA.get('u1', jobId))?.phase).toBe('awaiting_confirmation');
      });

      it('refuses every replica for as long as no claim can be taken', async () => {
        const jobId = await awaitingJob();
        backing.acquireLock = async () => {
          throw new Error('Redis unavailable');
        };

        const results = await Promise.all([
          replicaA.confirmStart('u1', jobId),
          replicaB.confirmStart('u1', jobId),
        ]);

        expect(results).toEqual([{ status: 'lock_unavailable' }, { status: 'lock_unavailable' }]);
        expect((await replicaA.get('u1', jobId))?.phase).toBe('awaiting_confirmation');
      });

      /** The refusal is the retryable kind: leaving the job where it was is
       * what makes the client's next attempt a normal start. */
      it('starts the job on the retry that follows a refused claim', async () => {
        const jobId = await awaitingJob();
        const acquire = backing.acquireLock;
        backing.acquireLock = async () => {
          throw new Error('Redis unavailable');
        };

        const refused = await replicaA.confirmStart('u1', jobId);
        backing.acquireLock = acquire;
        const retried = await replicaA.confirmStart('u1', jobId);

        expect(refused).toEqual({ status: 'lock_unavailable' });
        expect(retried).toMatchObject({ status: 'started', job: { phase: 'queued' } });
      });
    });

    it('rejects a third start attempt after the job already completed', async () => {
      const job = await store.create({ userId: 'u1', filepath: '/tmp/a.zip', filename: 'a.zip' });
      await store.patch('u1', job.jobId, { phase: 'awaiting_confirmation' });
      await store.confirmStart('u1', job.jobId);
      await store.patch('u1', job.jobId, { phase: 'completed', status: 'completed' });

      const result = await store.confirmStart('u1', job.jobId);

      expect(result.status).toBe('conflict');
    });
  });
});
