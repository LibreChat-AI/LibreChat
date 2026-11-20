import type { CheckpointRepository } from './types';
import type { IndexBuildOptions } from '../utils';
import { buildIndexWithRetry, isIndexBuildInProgress } from '../utils';

/** Longest wait for a peer's checkpoint index build before the saver proceeds without it. */
const CHECKPOINT_INDEX_BUILD_DEADLINE_MS = 120_000;

/**
 * `MongoDBSaver.setup()` starts the compound and TTL builds of each collection
 * concurrently and reports failures instead of throwing. Amazon DocumentDB
 * admits one index build per collection at a time, so there the second build of
 * each pair is rejected (code 40333) and the saver would otherwise run with its
 * TTL index missing — checkpoints then never expire. `setup()` is idempotent (an
 * index that already exists is a no-op), so re-running it lets one more build
 * through per pass until every index exists. Every other error is returned for
 * the caller to log, exactly as `setup()` reports it — including those reported
 * beside a conflict that outlasts the deadline. A rejection of `setup()` itself
 * propagates, so the caller keeps its in-process fallback.
 */
export async function setupCheckpointIndexes(
  saver: Pick<CheckpointRepository, 'setup'>,
  options: IndexBuildOptions = {},
): Promise<Error[]> {
  let companions: Error[] = [];
  try {
    return await buildIndexWithRetry(
      async () => {
        const errors = await saver.setup();
        const blocked = errors.find(isIndexBuildInProgress);
        if (blocked == null) {
          return errors;
        }
        companions = errors.filter((error) => !isIndexBuildInProgress(error));
        throw blocked;
      },
      'MongoDBSaver.setup()',
      { peerBuildDeadlineMs: CHECKPOINT_INDEX_BUILD_DEADLINE_MS, ...options },
    );
  } catch (error) {
    if (!isIndexBuildInProgress(error)) {
      throw error;
    }
    return [...companions, error instanceof Error ? error : new Error(String(error))];
  }
}
