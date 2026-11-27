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
