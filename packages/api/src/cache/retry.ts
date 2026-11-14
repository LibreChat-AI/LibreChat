type RedisRetryOptions = {
  label: string;
  maxAttempts: number;
  maxDelay: number;
  initialDelay: number;
  firstAttempt?: number;
  log: (message: string) => void;
};

/** Reconnect transport only; callers still own failed commands and their side effects. */
export function createRedisRetryStrategy({
  label,
  maxAttempts,
  maxDelay,
  initialDelay,
  firstAttempt = 1,
  log,
}: RedisRetryOptions): (attempt: number) => number | null {
  const maxExponent = Math.max(0, Math.ceil(Math.log2(maxDelay / initialDelay)));
  return (attempt) => {
    if (maxAttempts > 0 && attempt > maxAttempts) {
      log(`${label} giving up after ${maxAttempts} reconnection attempts`);
      return null;
    }
    // Saturate the exponent before computing it, even after months of reconnects.
    const exponent = Math.min(attempt, maxExponent);
    const base = Math.min(initialDelay * 2 ** exponent, maxDelay);
    // Keep jitter at the cap rather than clipping every retry to the same delay.
    const delay = base - Math.floor(Math.random() * Math.min(base / 2, 1000));
    const failure = attempt - firstAttempt + 1;
    if (failure === 1 || failure % 10 === 0) {
      log(`${label} reconnecting... attempt ${failure}, delay ${delay}ms`);
    }
    return delay;
  };
}
