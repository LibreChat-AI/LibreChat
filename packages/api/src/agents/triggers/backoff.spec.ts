import { WAITING_RETRY_CAP_MS, WAITING_RETRY_FLOOR_MS, waitingRetryAfter } from './backoff';

describe('waitingRetryAfter', () => {
  const since = Date.parse('2026-09-24T12:00:00Z');
  const floor = String(WAITING_RETRY_FLOOR_MS / 1_000);

  it('re-checks a fresh wait at the engine floor', () => {
    expect(waitingRetryAfter(since, since)).toBe(floor);
    expect(waitingRetryAfter(since, since + 45_000)).toBe(floor);
  });

  it('waits a tenth of the elapsed wait once that exceeds the floor', () => {
    expect(waitingRetryAfter(since, since + 120_000)).toBe('12');
    expect(waitingRetryAfter(since, since + 5 * 60_000)).toBe('30');
  });

  it('never waits longer than the cap', () => {
    expect(waitingRetryAfter(since, since + 6 * 60 * 60_000)).toBe(
      String(WAITING_RETRY_CAP_MS / 1_000),
    );
    expect(waitingRetryAfter(since, since + 10 * 60_000, 15_000)).toBe('15');
  });

  it('treats a missing or future start as a fresh wait', () => {
    expect(waitingRetryAfter(Number.NaN, since)).toBe(floor);
    expect(waitingRetryAfter(since + 60_000, since)).toBe(floor);
  });
});
