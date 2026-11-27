import type { AssistantRunIds } from './run';

/** The slice of the abort-key cache a recovery claim reads and clears. */
export interface AbortKeyCache {
  get: (key: string) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
}

/** The run a request would recover, and the abort key of its conversation. */
export interface RecoveryTarget extends AssistantRunIds {
  /** Names the conversation's current run as `thread_id:run_id`, which the stop route reads. */
  key: string;
  /** The run ended on its own while the request waited, so its controller bills and saves it. */
  settled?: boolean;
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
 * A request's failure and its response closing can both ask; only the first ask can get the run.
 */
export function createRecoveryClaim(
  cache: AbortKeyCache,
): (target: RecoveryTarget) => Promise<boolean> {
  let asked = false;
  return async ({ key, thread_id, run_id, settled = false }) => {
    if (asked) {
      return false;
    }
    asked = true;
    if (settled) {
      return false;
    }
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
