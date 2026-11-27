/**
 * Resolves with `promise`, but rejects as soon as `signal` aborts.
 *
 * Unlike handing the signal to the work itself, the underlying promise keeps
 * running. Use it for shared work whose lifetime outlives this caller — an OAuth
 * flow keyed by user and action that a concurrent run may also be awaiting and
 * that a browser callback will complete. Cancelling such work on one waiter's
 * abort strands the others and discards an authorization the user has already
 * granted; leaving the caller attached is equally wrong, because the value
 * arrives after the user pressed Stop and the caller acts on it.
 *
 * The detached promise's later settlement is swallowed rather than surfacing as
 * an unhandled rejection.
 */
export function detachOnAbort<T>(
  operation: T | PromiseLike<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  const promise = Promise.resolve(operation);
  if (signal == null) {
    return promise;
  }

  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Waits for every promise in `work` to settle, then resolves with their values in input order
 * or rejects with the first rejection in input order. Unlike `Promise.all`, a rejection does not
 * leave the rest running unobserved, so a write the caller started cannot land after the caller
 * has already failed and its owner moved on.
 */
export async function settleAll<T>(work: Iterable<T | PromiseLike<T>>): Promise<Awaited<T>[]> {
  const results = await Promise.allSettled(work);
  const values: Awaited<T>[] = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
    values.push(result.value);
  }
  return values;
}

/**
 * Runs `body`, then waits for the work it started before settling, even when `body` throws
 * partway through. `started` is read after `body` finishes, so it sees every promise `body`
 * pushed. A failure of `body` wins over a failure of the work it started; otherwise the first
 * rejected work, in the order `started` lists it, rejects the call.
 */
export async function settleStarted<T>(
  body: () => T | PromiseLike<T>,
  started: () => Iterable<unknown>,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    await Promise.allSettled(started());
    throw error;
  }
  await settleAll(started());
  return result;
}
