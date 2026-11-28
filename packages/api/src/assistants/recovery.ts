import { RunStatus, Time } from 'librechat-data-provider';

/** The error the Assistants controllers raise when the response closes before the run settled. */
export const REQUEST_CLOSED = 'Request closed';

/** How long a run stays claimed: as long as its conversation's abort entry can name it. */
const CLAIM_TTL_MS = Time.TEN_MINUTES;

/** The slice of the abort-key cache a recovery claim reads. */
export interface AbortKeyCache {
  get: (key: string) => Promise<unknown>;
}

/** Claims a key for a while, atomically across the instances sharing it (`createDistributedLock`). */
export interface RecoveryLock {
  acquire: (key: string, ttlMs: number) => Promise<string | null>;
  /** Frees a key only while `token`, from its `acquire`, still holds it. */
  release: (key: string, token: string) => Promise<boolean>;
}

/** A run's recovery, held by whoever claimed it. */
export interface RunClaim {
  /** Gives the run back, so a later stop or the run's own request can claim it. */
  release: () => Promise<void>;
}

/**
 * Claims the recovery of a run (cancelling, billing and reading it back). The stop route and the
 * request that started the run both claim before they recover it, so exactly one of them does,
 * whatever the conversation's abort entry names by then. Resolves with the claim, or with nothing
 * when another holds it.
 */
export async function claimRunRecovery(
  lock: RecoveryLock,
  run_id: string,
): Promise<RunClaim | null> {
  const key = `assistants:recovery:${run_id}`;
  const token = await lock.acquire(key, CLAIM_TTL_MS);
  if (token == null) {
    return null;
  }
  return {
    release: async () => {
      await lock.release(key, token);
    },
  };
}

export interface RecoveryClaimDeps {
  cache: AbortKeyCache;
  lock: RecoveryLock;
  /** The run the controller received once it ended; nothing while it has not received it. */
  completedRun: () => unknown;
}

/** The run a request would recover. */
export interface RecoveryTarget {
  /** The conversation's abort key, whose entry the stop route marks `cancelled` when it stops. */
  key: string;
  run_id: string;
  /** What the request's error handler got: the controller's failure, or {@link REQUEST_CLOSED}. */
  error: unknown;
}

/**
 * Hands out the recovery of a request's run when the run failed or its response closed before it
 * settled. The run is claimed per run, as the stop route claims it, so a stop and the request
 * never both recover it. The conversation's abort entry, which the next run of the conversation
 * replaces, is only read for the `cancelled` mark a stop leaves, which is also how a stop on an
 * instance without the claim says it took the run; nothing here writes or removes the entry.
 *
 * A request's failure and its response closing can both ask; only the first ask can get the run. A
 * close leaves a run whose end the controller received to the controller without using up that
 * ask: the controller bills and saves the run, and if that fails, its failure asks.
 */
export function createRecoveryClaim({
  cache,
  lock,
  completedRun,
}: RecoveryClaimDeps): (target: RecoveryTarget) => Promise<boolean> {
  let asked = false;
  return async ({ key, run_id, error }) => {
    const closed = error instanceof Error && error.message === REQUEST_CLOSED;
    if (asked || (closed && Boolean(completedRun()))) {
      return false;
    }
    asked = true;
    if ((await cache.get(key)) === RunStatus.CANCELLED) {
      return false;
    }
    return (await claimRunRecovery(lock, run_id)) != null;
  };
}
