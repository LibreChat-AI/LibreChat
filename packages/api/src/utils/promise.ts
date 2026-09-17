/**
 * Wraps a promise with a timeout. If the promise doesn't resolve/reject within
 * the specified time, it will be rejected with a timeout error.
 *
 * @param promise - The promise to wrap with a timeout
 * @param timeoutMs - Timeout duration in milliseconds
 * @param errorMessage - Custom error message for timeout (optional)
 * @param logger - Optional logger function to log timeout errors (e.g., console.warn, logger.warn)
 * @returns Promise that resolves/rejects with the original promise or times out
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   fetchData(),
 *   5000,
 *   'Failed to fetch data within 5 seconds',
 *   console.warn
 * );
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
  logger?: (message: string, error: Error) => void,
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(errorMessage ?? `Operation timed out after ${timeoutMs}ms`);
      if (logger) logger(error.message, error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * Tag-distinct rejection from a limiter whose queue is full, so callers can answer
 * "try again" instead of reporting the work itself as broken.
 */
export class ConcurrencyLimitError extends Error {
  readonly code = 'CONCURRENCY_LIMIT';
  /** Shed load is temporary, so the upload route answers it as retryable, not as a fault. */
  readonly userErrorStatusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyLimitError';
  }
}

export interface ConcurrencyLimiterOptions {
  /**
   * Most tasks allowed to wait for a slot. Beyond it, `run` rejects with
   * {@link ConcurrencyLimitError} instead of queueing. Omit for an unbounded queue,
   * which is right only when the producer is itself bounded (one tool result, one
   * agent turn) rather than one caller per inbound request.
   */
  maxQueued?: number;
  /** Names the limiter in the rejection message. */
  label?: string;
}

/**
 * Create an in-process concurrency limiter. Returns a `run` function that
 * wraps async tasks: at most `concurrency` invocations may execute at once;
 * additional calls queue and dequeue in FIFO order as slots free.
 *
 * Use to bound the parallelism of expensive CPU-or-IO work that fans out
 * from a single producer (e.g. an agent emitting many office artifacts in
 * one tool result), so the work doesn't compete with the still-running
 * agent inference for event-loop time. By default tasks remain queued and are
 * never dropped, so the overall workload still completes and only peak
 * concurrency is capped.
 *
 * That default is wrong when each caller is a separate inbound request holding
 * memory while it waits: capping running tasks caps neither the queue depth nor
 * what the queued callers retain. Pass `maxQueued` there, and the limiter sheds
 * load instead of accumulating it.
 *
 * Each task is wrapped in a thunk so timeouts and other side effects do
 * not start until the limiter actually invokes it.
 *
 * @example
 * ```typescript
 * const limit = createConcurrencyLimiter(2);
 * const results = await Promise.all(files.map((f) => limit(() => parse(f))));
 * ```
 */
export function createConcurrencyLimiter(
  concurrency: number,
  options: ConcurrencyLimiterOptions = {},
): <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `createConcurrencyLimiter: concurrency must be a positive integer (got ${concurrency})`,
    );
  }
  const { maxQueued, label = 'task' } = options;
  if (maxQueued !== undefined && (!Number.isInteger(maxQueued) || maxQueued < 0)) {
    throw new Error(
      `createConcurrencyLimiter: maxQueued must be a non-negative integer (got ${maxQueued})`,
    );
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const run = (): void => {
        active++;
        Promise.resolve()
          .then(task)
          .then(
            (value) => {
              release();
              resolve(value);
            },
            (error) => {
              release();
              reject(error);
            },
          );
      };
      if (active < concurrency) {
        run();
        return;
      }
      if (maxQueued !== undefined && queue.length >= maxQueued) {
        reject(
          new ConcurrencyLimitError(
            `Too many ${label} requests are already waiting (${concurrency} running, ${queue.length} queued).`,
          ),
        );
        return;
      }
      /* Leaving an abandoned waiter in place would hold a share of the bound against
       * callers who are still waiting: the queue exists to cap work in flight, and a
       * caller that gave up has none. Removed on abort rather than skipped on dequeue,
       * which frees the place immediately instead of when the queue finally reaches it. */
      const entry = (): void => {
        signal?.removeEventListener('abort', onAbort);
        run();
      };
      const onAbort = (): void => {
        const queued = queue.indexOf(entry);
        if (queued >= 0) {
          queue.splice(queued, 1);
        }
        reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(entry);
    });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Task was cancelled');
}
