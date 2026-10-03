import { v4 as uuidv4 } from 'uuid';
import { CacheKeys } from 'librechat-data-provider';

import type { LockableCache } from '~/cache/lock';
import type { ImportJob } from './types';

const DEFAULT_TTL = 24 * 60 * 60 * 1000;
const USER_MUTATION_LOCK_WAIT_MS = 250;
const MIN_LOCK_RENEW_INTERVAL_MS = 10;
/**
 * Keep required background mutations from holding capacity slots forever when
 * the shared claim store remains unavailable.
 */
const MAX_CLAIM_RETRY_ATTEMPTS = 3;

/**
 * The `_LOCK` suffix keeps claim keys disjoint from the Keyv data keys of the
 * same namespace. The braces put the claim and data key in one Redis Cluster
 * hash slot, which lets the final token check and data write run in one script.
 */
const CLAIM_KEY_PREFIX = `${CacheKeys.IMPORT_JOBS}_LOCK`;

function emptyProgress(): ImportJob['progress'] {
  return {
    conversations: { done: 0, total: 0 },
    messages: { done: 0, total: 0 },
    assets: { done: 0, total: 0 },
  };
}

export type CancelResult = {
  status: 'cancelled' | 'not_found' | 'lock_unavailable';
  previousPhase: ImportJob['phase'] | null;
};

export type StartTransitionResult =
  | { status: 'started'; job: ImportJob }
  | { status: 'not_found' }
  | { status: 'conflict'; job: ImportJob }
  | { status: 'lock_unavailable' };

/**
 * Statuses a job never moves out of. Reaching one freezes `status` and
 * `phase`: the background run's `isCancelled`/`onPhase`/`onProgress`
 * callbacks each read and write separately, so a `DELETE` landing between
 * one of those reads and its write would otherwise walk a cancelled job back
 * into `phase: 'conversations'`, leaving the client polling forever a job
 * whose run has already stopped. Every other field (`report`, `progress`)
 * still applies, so a cancelled job still gains the partial report
 * describing what was written before it stopped.
 */
const TERMINAL_STATUSES = new Set<ImportJob['status']>(['cancelled', 'completed', 'failed']);

type ImportJobPatch = Omit<Partial<ImportJob>, 'userId' | 'jobId'>;

function applyTerminalGuard(existing: ImportJob, patch: ImportJobPatch): ImportJobPatch {
  if (!TERMINAL_STATUSES.has(existing.status)) {
    return patch;
  }
  const { status: _status, phase: _phase, ...rest } = patch;
  return rest;
}

export class ImportJobStore {
  private readonly store: LockableCache;
  private readonly ttl: number;
  /** Serializes every mutation sharing the same job key. `Keyv`'s
   * `get`/`set` pair is not itself atomic: without this, two racing
   * `/start` requests can both read `awaiting_confirmation` before either
   * write lands (launching the background run twice over the same archive),
   * and a progress update that read an active job can land after a
   * cancellation and resurrect it. Scoped to this process, which is all an
   * in-memory job store can be shared by. A shared store additionally takes
   * the same distributed claim for every mutation. */
  private readonly transitionLocks = new Map<string, Promise<void>>();

  constructor(store: LockableCache, ttl: number = DEFAULT_TTL) {
    this.store = store;
    this.ttl = ttl;
  }

  private key(userId: string, jobId: string): string {
    return `{${userId}:${jobId}}`;
  }

  async create(input: { userId: string; filepath: string; filename: string }): Promise<ImportJob> {
    const now = Date.now();
    const job: ImportJob = {
      jobId: uuidv4(),
      userId: input.userId,
      filepath: input.filepath,
      filename: input.filename,
      phase: 'queued',
      status: 'active',
      summary: null,
      progress: emptyProgress(),
      report: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.set(this.key(input.userId, job.jobId), job, this.ttl);
    return job;
  }

  async get(userId: string, jobId: string): Promise<ImportJob | null> {
    const job = await this.store.get<ImportJob>(this.key(userId, jobId));
    return job ?? null;
  }

  /** The read-modify-write itself, without either lock. */
  private async applyPatch(
    userId: string,
    jobId: string,
    patch: ImportJobPatch,
    writeIfOwned?: (key: string, value: ImportJob, ttl: number) => Promise<void>,
  ): Promise<ImportJob | null> {
    const existing = await this.get(userId, jobId);
    if (!existing) {
      return null;
    }

    const updated: ImportJob = {
      ...existing,
      ...applyTerminalGuard(existing, patch),
      updatedAt: Date.now(),
    };
    const key = this.key(userId, jobId);
    if (writeIfOwned) {
      await writeIfOwned(key, updated, this.ttl);
    } else {
      await this.store.set(key, updated, this.ttl);
    }
    return updated;
  }

  async patch(userId: string, jobId: string, patch: ImportJobPatch): Promise<ImportJob | null> {
    return this.withMutationLock<ImportJob | null>(
      userId,
      jobId,
      (writeIfOwned) => this.applyPatch(userId, jobId, patch, writeIfOwned),
      'retry',
    );
  }

  async patchProgress(
    userId: string,
    jobId: string,
    progress: ImportJob['progress'],
  ): Promise<ImportJob | null> {
    return this.withMutationLock<ImportJob | null>(
      userId,
      jobId,
      (writeIfOwned) => this.applyPatch(userId, jobId, { progress }, writeIfOwned),
      'bounded',
      () => null,
    );
  }

  /**
   * Cancels a job and reports the phase it was actually cancelled *from*,
   * read under the same lock as the write. The caller removes the temporary
   * upload only for a job that never left `awaiting_confirmation`; a phase
   * snapshotted before the lock can be stale by the time the cancellation
   * lands, which would delete the archive out from under a run that has just
   * claimed it.
   */
  async cancel(userId: string, jobId: string): Promise<CancelResult> {
    return this.withMutationLock<CancelResult>(
      userId,
      jobId,
      async (writeIfOwned) => {
        const existing = await this.get(userId, jobId);
        if (!existing) {
          return { status: 'not_found', previousPhase: null };
        }
        const updated = await this.applyPatch(
          userId,
          jobId,
          {
            status: 'cancelled',
            phase: 'cancelled',
          },
          writeIfOwned,
        );
        if (!updated) {
          return { status: 'not_found', previousPhase: null };
        }
        return { status: 'cancelled', previousPhase: existing.phase };
      },
      'bounded',
      () => ({ status: 'lock_unavailable', previousPhase: null }),
    );
  }

  async isCancelled(userId: string, jobId: string): Promise<boolean> {
    const job = await this.get(userId, jobId);
    return job?.status === 'cancelled';
  }

  private async withTransitionLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.transitionLocks.get(lockKey) ?? Promise.resolve();
    const settled = previous.then(fn);
    const tracked: Promise<void> = settled.then(
      () => undefined,
      () => undefined,
    );
    this.transitionLocks.set(lockKey, tracked);
    try {
      return await settled;
    } finally {
      if (this.transitionLocks.get(lockKey) === tracked) {
        this.transitionLocks.delete(lockKey);
      }
    }
  }

  /**
   * Runs a mutation while holding the job's claim, so every read-modify-write
   * is exclusive across replicas sharing the store. `Keyv` has no atomic
   * compare-and-set, so all mutations must use the same `SET NX PX` claim.
   *
   * Contention waits for the current mutation to finish, then reads the state
   * it actually wrote. This preserves progress patches and prevents a losing
   * start from reporting a still-awaiting job as permanently started.
   *
   * A store that raises while handing out the claim gets `unavailable`, not
   * `claimed`. A namespace only carries claim helpers because it is genuinely
   * shared between replicas, so a caller that cannot take the claim cannot
   * prove it is the only one confirming this job, and starting anyway would
   * restore the duplicate-run race for as long as the store stays degraded.
   * User-facing start and cancel operations return an unavailable result, so
   * routes can fail closed with a retryable response. Required background
   * state transitions retry a few times before surfacing store unavailability,
   * while best-effort progress writes return without changing the job when the
   * claim is unavailable.
   *
   * A store with no claim helpers is the in-memory fallback, which no second
   * replica can be reading, so `claimed` runs on the in-process lock alone.
   */
  private async withClaim<T>(
    lockKey: string,
    claimed: (
      writeIfOwned?: (key: string, value: ImportJob, ttl: number) => Promise<void>,
    ) => Promise<T>,
    acquisitionBehavior: 'retry' | 'bounded',
    unavailable: () => T,
  ): Promise<T> {
    const { acquireLock, extendLock, releaseLock, setIfLockOwned, lockTtl } = this.store;
    if (!acquireLock) {
      return claimed();
    }
    if (!setIfLockOwned) {
      return unavailable();
    }
    let acquisitionAttempts = 0;
    while (true) {
      let token: string | null = null;
      const waitUntil = Date.now() + USER_MUTATION_LOCK_WAIT_MS;
      while (!token) {
        let acquisitionError: unknown;
        try {
          token = await acquireLock(lockKey);
        } catch (error) {
          acquisitionError = error;
        }
        if (!token) {
          if (acquisitionError && acquisitionBehavior === 'bounded') {
            return unavailable();
          }
          acquisitionAttempts += 1;
          if (acquisitionBehavior === 'bounded' && Date.now() >= waitUntil) {
            return unavailable();
          }
          if (acquisitionBehavior === 'retry' && acquisitionAttempts >= MAX_CLAIM_RETRY_ATTEMPTS) {
            throw acquisitionError ?? new Error('Import job mutation lock unavailable');
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      acquisitionAttempts = 0;

      let lockLost = false;
      let renewal: Promise<void> | null = null;
      const renew = async (): Promise<void> => {
        if (!extendLock || lockLost) {
          return;
        }
        if (!renewal) {
          renewal = (async () => {
            try {
              lockLost = !(await extendLock(lockKey, token));
            } catch {
              lockLost = true;
            }
          })().finally(() => {
            renewal = null;
          });
        }
        await renewal;
      };
      const assertOwned = async (): Promise<void> => {
        await renew();
        if (lockLost) {
          throw new Error('Import job mutation lock lost');
        }
      };
      const writeIfOwned = async (key: string, value: ImportJob, ttl: number): Promise<void> => {
        await assertOwned();
        const written = await setIfLockOwned(lockKey, key, token, value, ttl);
        if (!written) {
          lockLost = true;
          throw new Error('Import job mutation lock lost');
        }
      };
      const renewInterval =
        extendLock && lockTtl
          ? setInterval(() => void renew(), Math.max(MIN_LOCK_RENEW_INTERVAL_MS, lockTtl / 3))
          : null;

      try {
        return await claimed(writeIfOwned);
      } catch (error) {
        if (!lockLost) {
          throw error;
        }
        if (acquisitionBehavior === 'bounded') {
          return unavailable();
        }
      } finally {
        if (renewInterval) {
          clearInterval(renewInterval);
        }
        await releaseLock?.(lockKey, token).catch(() => undefined);
      }
    }
  }

  private async withMutationLock<T>(
    userId: string,
    jobId: string,
    mutation: (
      writeIfOwned?: (key: string, value: ImportJob, ttl: number) => Promise<void>,
    ) => Promise<T>,
    unavailableBehavior: 'retry' | 'bounded',
    unavailable?: () => T,
  ): Promise<T> {
    const jobKey = this.key(userId, jobId);
    const claimKey = `${CLAIM_KEY_PREFIX}:${jobKey}`;
    return this.withTransitionLock(jobKey, () =>
      this.withClaim(claimKey, mutation, unavailableBehavior, () => {
        if (unavailableBehavior === 'bounded' && unavailable) {
          return unavailable();
        }
        throw new Error('Import job mutation lock unavailable');
      }),
    );
  }

  /**
   * Atomically moves a job out of `awaiting_confirmation` so at most one
   * caller ever launches the background run for it. A second, racing call
   * for the same job (a double-click, a client retry, a replay, or another
   * replica serving any of those) observes the job already out of that phase
   * and gets `status: 'conflict'` instead of silently re-running the import
   * over the same archive.
   *
   * The job lands in `queued`, not in a working phase: the background run
   * announces `assets` and then `conversations` itself, so the phase the
   * client polls always reflects what the run is actually doing.
   *
   * `lock_unavailable` is the one non-terminal answer: the shared store could
   * not be asked whether this replica may proceed, so the job is untouched and
   * still awaiting confirmation, and the caller should retry.
   */
  async confirmStart(userId: string, jobId: string): Promise<StartTransitionResult> {
    return this.withMutationLock<StartTransitionResult>(
      userId,
      jobId,
      (writeIfOwned) => this.transitionToQueued(userId, jobId, writeIfOwned),
      'bounded',
      () => ({ status: 'lock_unavailable' }),
    );
  }

  private async transitionToQueued(
    userId: string,
    jobId: string,
    writeIfOwned?: (key: string, value: ImportJob, ttl: number) => Promise<void>,
  ): Promise<StartTransitionResult> {
    const existing = await this.get(userId, jobId);
    if (!existing) {
      return { status: 'not_found' };
    }
    if (existing.phase !== 'awaiting_confirmation') {
      return { status: 'conflict', job: existing };
    }
    const updated = await this.applyPatch(userId, jobId, { phase: 'queued' }, writeIfOwned);
    if (!updated) {
      return { status: 'not_found' };
    }
    /** Defensive validation keeps an unexpected guarded transition from being
     * reported as a successful start. */
    if (updated.phase !== 'queued') {
      return { status: 'conflict', job: updated };
    }
    return { status: 'started', job: updated };
  }
}
