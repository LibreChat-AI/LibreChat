export interface RedisFinalizationRecovery {
  readonly timeoutMs: number;
  deadline?: number;
}

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

/** Share one retry window across phases without timing out in-flight Redis commands.
 * Each phase gets its first attempt even after expiry, so a writable Redis can still accept a drain. */
export async function retryRedisFinalization<T>(
  recovery: RedisFinalizationRecovery | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (recovery == null || recovery.timeoutMs === 0) return run();
  let delay = 100;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!isRedisOutage(error)) throw error;
      const now = performance.now();
      const deadline = (recovery.deadline ??= now + recovery.timeoutMs);
      const wait = delay - Math.random() * delay * 0.25;
      if (now + wait >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      if (performance.now() >= deadline) throw error;
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

export const REDIS_STREAM_INTERRUPTED: Error = new Error('Generation interrupted');

export function isRedisStreamInterrupted(signal: AbortSignal): boolean {
  return signal.reason === REDIS_STREAM_INTERRUPTED;
}
