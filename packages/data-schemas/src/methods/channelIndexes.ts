import { createIndexesWithRetry } from '~/utils/retry';

/** Unique indexes are correctness fences, even when automatic indexing is disabled. */
export function createChannelIndexGate(
  models: () => Array<Parameters<typeof createIndexesWithRetry>[0]>,
  afterReady?: () => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= (async () => {
      for (const model of models()) await createIndexesWithRetry(model);
      await afterReady?.();
    })().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
