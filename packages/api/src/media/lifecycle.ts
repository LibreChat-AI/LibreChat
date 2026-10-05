import type { MediaLogger } from './logging';
import type { MediaWorker } from './worker';
import { createMediaLog } from './logging';

export async function startMediaWorker(
  worker: Pick<MediaWorker, 'start'>,
  logger: MediaLogger,
): Promise<void> {
  try {
    await worker.start();
  } catch (error) {
    createMediaLog(logger.error.bind(logger))(
      '[media] Worker is PERMANENTLY unavailable in this process. Resolve the startup error and restart.',
      error instanceof Error ? error : undefined,
    );
  }
}

/** Includes a cluster primary's earlier deadline when draining a worker process. */
export function createMediaWorkerStop(
  worker: Pick<MediaWorker, 'stop'>,
  remainingMs: () => number | null,
  externalDeadlineAt: () => number | null = () => null,
  now: () => number = Date.now,
): () => Promise<void> {
  return () => {
    const remaining = remainingMs();
    const deadline = externalDeadlineAt();
    const budgetMs = Math.min(
      remaining ?? Infinity,
      deadline == null ? Infinity : deadline - now(),
    );
    return worker.stop({ budgetMs: Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : undefined });
  };
}
