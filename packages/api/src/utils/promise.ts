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
 * Create an in-process concurrency limiter. Returns a `run` function that
 * wraps async tasks: at most `concurrency` invocations may execute at once;
 * additional calls queue and dequeue in FIFO order as slots free.
 *
 * Use to bound the parallelism of expensive CPU-or-IO work that fans out
 * from a single producer (e.g. an agent emitting many office artifacts in
 * one tool result), so the work doesn't compete with the still-running
 * agent inference for event-loop time. Tasks remain queued — they are
 * never dropped or rejected by the limiter itself — so the overall workload
 * still completes; only peak concurrency is capped.
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
): <T>(task: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `createConcurrencyLimiter: concurrency must be a positive integer (got ${concurrency})`,
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

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
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
      } else {
        queue.push(run);
      }
    });
}
