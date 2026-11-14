import { createRedisRetryStrategy } from './retry';

describe('Redis reconnect policy', () => {
  const log = jest.fn();
  const options = {
    label: 'Redis',
    maxAttempts: 0,
    maxDelay: 3000,
    initialDelay: 50,
    log,
  };

  beforeEach(() => log.mockClear());

  it('keeps retrying for the lifetime of the process without overflowing the backoff', () => {
    const retry = createRedisRetryStrategy(options);
    for (const attempt of [1, 10, 100, 1024, 100_000, Number.MAX_SAFE_INTEGER]) {
      const delay = retry(attempt);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(options.maxDelay);
    }
  });

  it('retains jitter once the exponential delay has reached its cap', () => {
    const random = jest.spyOn(Math, 'random');
    const retry = createRedisRetryStrategy(options);
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    expect(retry(10_000)).toBe(3000);
    expect(retry(10_000)).toBe(2001);
  });

  it.each([50, 100])(
    'grows the existing %sms backoff and respects a smaller cap',
    (initialDelay) => {
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const retry = createRedisRetryStrategy({ ...options, initialDelay });
      expect(retry(1)).toBe(initialDelay * 2);
      expect(retry(2)).toBe(initialDelay * 4);
      expect(createRedisRetryStrategy({ ...options, initialDelay, maxDelay: 1 })(100_000)).toBe(1);
    },
  );

  it.each([0, 1])('preserves finite overrides for a client counting from %s', (firstAttempt) => {
    const retry = createRedisRetryStrategy({ ...options, maxAttempts: 2, firstAttempt });
    for (let attempt = firstAttempt; attempt <= 2; attempt++) {
      expect(retry(attempt)).not.toBeNull();
    }
    expect(retry(3)).toBeNull();
    expect(log).toHaveBeenLastCalledWith('Redis giving up after 2 reconnection attempts');
  });

  it.each([0, 1])(
    'logs the first and every tenth failure for a client counting from %s',
    (firstAttempt) => {
      const retry = createRedisRetryStrategy({ ...options, firstAttempt });
      for (let attempt = firstAttempt; attempt < firstAttempt + 100; attempt++) {
        retry(attempt);
      }
      expect(log).toHaveBeenCalledTimes(11);
      expect(log.mock.calls[0][0]).toContain('attempt 1,');
      expect(log.mock.calls[1][0]).toContain('attempt 10,');
      expect(log.mock.calls[10][0]).toContain('attempt 100,');
    },
  );
});
