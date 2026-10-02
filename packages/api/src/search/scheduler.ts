export const MEILI_INDEX_SYNC_INTERVAL_MS = 60_000;
export const MEILI_INDEX_SYNC_REFRESH_MS = 60_000;
export const MEILI_INDEX_SYNC_LEASE_MS: number = MEILI_INDEX_SYNC_REFRESH_MS * 3;

type IndexSyncReason = 'startup' | 'periodic';

interface IndexSyncSchedulerOptions {
  run: (reason: IndexSyncReason, signal: AbortSignal) => Promise<unknown>;
  onError: (error: unknown) => void;
  intervalMs?: number;
}

interface IndexSyncScheduler {
  stop(): Promise<void>;
}

/**
 * Runs index reconciliation at startup and periodically without allowing local overlap.
 * Cross-replica coordination remains the responsibility of the distributed index-sync job.
 */
export function startIndexSyncScheduler({
  run,
  onError,
  intervalMs = MEILI_INDEX_SYNC_INTERVAL_MS,
}: IndexSyncSchedulerOptions): IndexSyncScheduler {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('Meilisearch index sync interval must be a positive finite number');
  }

  let inFlight: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let stopped = false;
  const invoke = (reason: IndexSyncReason): void => {
    if (stopped || inFlight != null) {
      return;
    }
    const controller = new AbortController();
    activeController = controller;
    const current = Promise.resolve()
      .then(() => {
        if (stopped) {
          return;
        }
        return run(reason, controller.signal);
      })
      .catch((error) => {
        if (!stopped) {
          onError(error);
        }
      })
      .then(() => undefined)
      .finally(() => {
        if (inFlight === current) {
          inFlight = undefined;
          activeController = undefined;
        }
      });
    inFlight = current;
  };

  invoke('startup');
  const timer = setInterval(() => invoke('periodic'), intervalMs);
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      activeController?.abort(new Error('Meilisearch index sync scheduler stopped'));
      await inFlight;
    },
  };
}
