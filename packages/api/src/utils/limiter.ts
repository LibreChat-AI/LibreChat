import type { RateLimitInfo } from 'express-rate-limit';

export interface RateLimitReset {
  /** Epoch milliseconds at which the client's window reopens. */
  resetAt: number;
  /** Whole seconds until `resetAt`, never below one, as a `Retry-After` header expects. */
  retryAfterSeconds: number;
}

/**
 * When a rate-limited client may retry. `express-rate-limit` reports the reset on
 * `req.rateLimit.resetTime` for stores that track it; without one, the window is assumed to reopen
 * one full window from now, the latest its current count can still apply.
 */
export function getRateLimitReset(
  rateLimit: Pick<RateLimitInfo, 'resetTime'> | undefined,
  windowMs: number,
  now: number = Date.now(),
): RateLimitReset {
  const reportedResetAt =
    rateLimit?.resetTime instanceof Date ? rateLimit.resetTime.getTime() : Number.NaN;
  const resetAt = Number.isFinite(reportedResetAt) ? reportedResetAt : now + windowMs;
  return {
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}
