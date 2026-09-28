import logger from '~/config/winston';

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  retryableErrors?: string[];
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxAttempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 10_000,
  jitter: true,
  retryableErrors: ['deadlock', 'lock timeout', 'write conflict', 'ECONNRESET'],
};

/**
 * Executes an async operation with exponential backoff + jitter retry
 * on transient errors (deadlocks, connection resets, lock timeouts).
 *
 * Designed for FerretDB/DocumentDB operations where concurrent index
 * creation or bulk writes can trigger PostgreSQL-level deadlocks.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  label: string,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_OPTIONS.maxAttempts,
    baseDelayMs = DEFAULT_OPTIONS.baseDelayMs,
    maxDelayMs = DEFAULT_OPTIONS.maxDelayMs,
    jitter = DEFAULT_OPTIONS.jitter,
    retryableErrors = DEFAULT_OPTIONS.retryableErrors,
  } = options;

  /** Negated comparisons, so a NaN option is rejected rather than skipping every attempt. */
  if (!(maxAttempts >= 1) || !(baseDelayMs >= 0) || !(maxDelayMs >= 0)) {
    throw new Error(
      `[retryWithBackoff] Invalid options: maxAttempts must be >= 1, delays must be non-negative`,
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      const message = (err as Error)?.message ?? String(err);
      const isRetryable = retryableErrors.some((pattern) =>
        message.toLowerCase().includes(pattern.toLowerCase()),
      );

      if (!isRetryable || attempt === maxAttempts) {
        logger.error(
          `[retryWithBackoff] ${label} failed permanently after ${attempt} attempt(s): ${message}`,
        );
        throw err;
      }

      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitterMs = jitter ? Math.random() * baseDelayMs : 0;
      const delayMs = Math.min(exponentialDelay + jitterMs, maxDelayMs);

      logger.warn(
        `[retryWithBackoff] ${label} attempt ${attempt}/${maxAttempts} failed (${message}), retrying in ${Math.round(delayMs)}ms`,
      );

      if (options.onRetry) {
        const normalizedError = err instanceof Error ? err : new Error(String(err));
        options.onRetry(normalizedError, attempt, delayMs);
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `[retryWithBackoff] ${label} exhausted ${maxAttempts} attempt(s) without an outcome`,
  );
}

interface IndexedModel {
  createIndexes: () => Promise<unknown>;
  init?: () => Promise<unknown>;
  modelName: string;
}

export interface IndexBuildOptions extends RetryOptions {
  /** Interval between attempts while another build holds the collection. */
  peerBuildPollMs?: number;
  /** Longest wait for another build to finish; unbounded when omitted. */
  peerBuildDeadlineMs?: number;
}

/** Amazon DocumentDB rejects a createIndex that arrives while another build on the
 * same collection is running (code 40333), where MongoDB would serialize it. */
const INDEX_BUILD_ALREADY_IN_PROGRESS = 40333;
const INDEX_BUILD_IN_PROGRESS_MESSAGE = 'index build in progress';
const DEFAULT_PEER_BUILD_POLL_MS = 5_000;

export function isIndexBuildInProgress(error: unknown): boolean {
  const candidate = error as { code?: number; message?: string } | null;
  if (candidate?.code === INDEX_BUILD_ALREADY_IN_PROGRESS) {
    return true;
  }
  return (candidate?.message ?? '').toLowerCase().includes(INDEX_BUILD_IN_PROGRESS_MESSAGE);
}

/**
 * Mongoose starts every compiled model's automatic index build in the background
 * as soon as its connection opens. An explicit build issued while that one is
 * still running is a second concurrent build of the same collection, which
 * single-build engines reject outright. Letting the automatic build settle first
 * keeps the two from overlapping; if it failed, the explicit build below is the
 * retry, so its outcome is deliberately ignored here.
 */
async function settleAutomaticIndexBuild(model: IndexedModel): Promise<void> {
  if (model.init == null) {
    return;
  }
  await model.init().catch(() => undefined);
}

/**
 * Runs one index build, waiting while another process (a peer replica booting
 * the same release) holds the collection's single index build slot. A peer's
 * build time is data-dependent, so the wait polls rather than backs off: the
 * caller cannot become ready without the index, and giving up only restarts it
 * into the same wait. The deadline counts from the first conflict rather than
 * from the first attempt — a builder that admits one long build before
 * reporting another's conflict has not been waiting on anyone yet, so it always
 * gets a rerun. Every other error propagates at once.
 */
async function buildWhenCollectionFree<T>(
  build: () => Promise<T>,
  label: string,
  options: IndexBuildOptions,
): Promise<T> {
  const pollMs = options.peerBuildPollMs ?? DEFAULT_PEER_BUILD_POLL_MS;
  let waitingSince: number | undefined;
  for (;;) {
    try {
      return await build();
    } catch (error: unknown) {
      if (!isIndexBuildInProgress(error)) {
        throw error;
      }
      if (waitingSince == null) {
        waitingSince = Date.now();
      }
      const elapsedMs = Date.now() - waitingSince;
      if (options.peerBuildDeadlineMs != null && elapsedMs >= options.peerBuildDeadlineMs) {
        throw error;
      }
      logger.warn(
        `[buildIndexWithRetry] ${label} is waiting for another index build on the collection to finish (${Math.round(elapsedMs / 1000)}s elapsed, next attempt in ${pollMs}ms)`,
      );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/**
 * Runs an index build with peer-build polling and transient-error retry, for a
 * caller that holds a raw driver collection or a third-party builder rather
 * than a Mongoose model. `build` is re-invoked until it settles, so it must be
 * idempotent — which every `createIndex` of an existing spec is.
 * Use this (or `createIndexesWithRetry`) instead of a raw `createIndex` on
 * FerretDB or DocumentDB; the static guard in `methods/documentdb.spec.ts`
 * rejects a raw call outside this module.
 */
export async function buildIndexWithRetry<T>(
  build: () => Promise<T>,
  label: string,
  options: IndexBuildOptions = {},
): Promise<T> {
  return await retryWithBackoff(
    () => buildWhenCollectionFree(build, label, options),
    label,
    options,
  );
}

/**
 * Creates all indexes for a Mongoose model with deadlock retry.
 * Use this instead of raw `model.createIndexes()` on FerretDB or DocumentDB.
 */
export async function createIndexesWithRetry(
  model: IndexedModel,
  options: IndexBuildOptions = {},
): Promise<void> {
  await settleAutomaticIndexBuild(model);
  await buildIndexWithRetry(
    () => model.createIndexes(),
    `createIndexes(${model.modelName})`,
    options,
  );
}

/**
 * Initializes all collections and indexes for a set of models on a connection,
 * with per-model deadlock retry. Models are processed sequentially to minimize
 * contention on the DocumentDB catalog.
 */
export async function initializeOrgCollections(
  models: Record<string, IndexedModel & { createCollection: () => Promise<unknown> }>,
  options: IndexBuildOptions = {},
): Promise<{ totalMs: number; perModel: Array<{ name: string; ms: number }> }> {
  const perModel: Array<{ name: string; ms: number }> = [];
  const t0 = Date.now();

  for (const model of Object.values(models)) {
    const modelStart = Date.now();
    await model.createCollection();
    await createIndexesWithRetry(model, options);
    perModel.push({ name: model.modelName, ms: Date.now() - modelStart });
  }

  return { totalMs: Date.now() - t0, perModel };
}
