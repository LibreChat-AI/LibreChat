import type { AssistantRunIds } from './run';

/** The error the Assistants controllers raise when the response closes before the run settled. */
export const REQUEST_CLOSED = 'Request closed';

/** The slice of the abort-key cache a recovery claim reads and clears. */
export interface AbortKeyCache {
  get: (key: string) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
}

export interface RecoveryClaimDeps {
  cache: AbortKeyCache;
  /** The run the controller received once it ended; nothing while it has not received it. */
  completedRun: () => unknown;
}

/** The run a request would recover, and the abort key of its conversation. */
export interface RecoveryTarget extends AssistantRunIds {
  /** Names the conversation's current run as `thread_id:run_id`, which the stop route reads. */
  key: string;
  /** What the request's error handler got: the controller's failure, or {@link REQUEST_CLOSED}. */
  error: unknown;
}

/**
 * Hands out the recovery of a request's run (cancelling, billing and reading it back) when the
 * run failed or its response closed before it settled.
 *
 * The conversation's abort entry names its current run. The stop route marks the entry
 * `cancelled` before it recovers that run itself, and the next run of the conversation replaces
 * the entry with its own. So the run is the request's to recover only while the entry still names
 * it, or once the entry is gone. A claim removes the run's entry, so a later stop finds nothing to
 * recover; an entry naming another run is left alone, since the stop route finds that run by it.
 * The read and the removal are two cache calls, as the stop route's read and mark are: a run the
 * provider accepted on the thread in between would lose its entry, which needs this run to have
 * ended already and another client to start one within that round trip.
 *
 * A request's failure and its response closing can both ask; only the first ask can get the run. A
 * close leaves a run whose end the controller received to the controller without using up that
 * ask: the controller bills and saves the run, and if that fails, its failure asks.
 */
export function createRecoveryClaim({
  cache,
  completedRun,
}: RecoveryClaimDeps): (target: RecoveryTarget) => Promise<boolean> {
  let asked = false;
  return async ({ key, thread_id, run_id, error }) => {
    const closed = error instanceof Error && error.message === REQUEST_CLOSED;
    if (asked || (closed && Boolean(completedRun()))) {
      return false;
    }
    asked = true;
    const entry = await cache.get(key);
    if (entry == null) {
      return true;
    }
    if (entry !== `${thread_id}:${run_id}`) {
      return false;
    }
    await cache.delete(key);
    return true;
  };
}
