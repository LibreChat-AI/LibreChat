const REDIS_RECOVERY_MS = 30_000;

export function isRedisOutage(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'MaxRetriesPerRequestError' ||
      /^(?:Reached the max retries per request limit|Connection is closed|Stream isn't writeable|None of startup nodes is available|Failed to refresh slots cache|(?:READONLY|CLUSTERDOWN|MASTERDOWN|LOADING|TRYAGAIN)\b)/.test(
        error.message,
      ) ||
      ('code' in error &&
        (error.code === 'ECONNRESET' ||
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'EPIPE')))
  );
}

/** Retry only operations whose result can be safely recovered after a lost reply. */
export async function retryRedisFinalization<T>(run: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + REDIS_RECOVERY_MS;
  let delay = 100;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!isRedisOutage(error) || performance.now() + delay >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delay - Math.random() * delay * 0.25),
      );
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

export const REDIS_STREAM_INTERRUPTED: Error = new Error('Generation interrupted');

export function isRedisStreamInterrupted(signal: AbortSignal): boolean {
  return signal.reason === REDIS_STREAM_INTERRUPTED;
}
