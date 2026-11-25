import { getRateLimitReset } from './limiter';

describe('getRateLimitReset', () => {
  const now = Date.UTC(2026, 8, 13, 12, 0, 0);

  it('reports the reset time the limiter store tracked', () => {
    const resetTime = new Date(now + 7 * 60 * 1000);

    expect(getRateLimitReset({ resetTime }, 60_000, now)).toEqual({
      resetAt: resetTime.getTime(),
      retryAfterSeconds: 420,
    });
  });

  it('rounds a partial second up so a retry never lands inside the window', () => {
    const resetTime = new Date(now + 1_200);

    expect(getRateLimitReset({ resetTime }, 60_000, now).retryAfterSeconds).toBe(2);
  });

  it.each([
    ['no rate limit info', undefined],
    ['a store without reset tracking', { resetTime: undefined }],
    ['an invalid reset date', { resetTime: new Date(Number.NaN) }],
  ])('falls back to one full window for %s', (_label, rateLimit) => {
    expect(getRateLimitReset(rateLimit, 3 * 24 * 60 * 60 * 1000, now)).toEqual({
      resetAt: now + 3 * 24 * 60 * 60 * 1000,
      retryAfterSeconds: 3 * 24 * 60 * 60,
    });
  });

  it('never tells a client to retry in less than a second', () => {
    const resetTime = new Date(now - 5_000);

    expect(getRateLimitReset({ resetTime }, 60_000, now)).toEqual({
      resetAt: resetTime.getTime(),
      retryAfterSeconds: 1,
    });
  });
});
