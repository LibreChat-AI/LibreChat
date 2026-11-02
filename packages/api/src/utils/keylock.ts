const tails = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` after every earlier task queued under the same `key` has settled, so a
 * read-modify-write against a store without atomic operations cannot interleave
 * with another one in this process. It does not coordinate separate processes.
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
  return run;
}

/**
 * Wraps an async task for use in a timer so a slow run is never overlapped by the
 * next tick and a rejection is reported instead of becoming an unhandled rejection.
 */
export function createSingleFlight(
  task: () => Promise<unknown>,
  log: { error: (message: string, error: unknown) => void },
  label: string,
): () => void {
  let running = false;
  return () => {
    if (running) {
      return;
    }
    running = true;
    task()
      .catch((error) => log.error(`${label} failed`, error))
      .finally(() => {
        running = false;
      });
  };
}

/**
 * Resolves with `work`, or with `undefined` after `ms` (logging the timeout). The timer is
 * always cleared, so a settled race never leaves it pending.
 */
export async function raceWithTimeout<T>(
  work: Promise<T>,
  ms: number,
  log: { error: (message: string, error: unknown) => void },
  label: string,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      log.error(`${label} error:`, new Error(`${label} timeout`));
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
