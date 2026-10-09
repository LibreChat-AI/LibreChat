import {
  computeExpiresAt,
  getExpiryStatus,
  formatDate,
  EXPIRY_NEVER,
  DEFAULT_EXPIRY,
} from '../utils';

describe('computeExpiresAt', () => {
  it('returns null for the never option', () => {
    expect(computeExpiresAt(EXPIRY_NEVER)).toBeNull();
  });

  it('returns an ISO date the given number of days ahead', () => {
    const result = computeExpiresAt('7');
    expect(result).not.toBeNull();
    const diffDays = (new Date(result as string).getTime() - Date.now()) / 86400000;
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });

  it('returns null for non-numeric input', () => {
    expect(computeExpiresAt('abc')).toBeNull();
  });
});

describe('getExpiryStatus', () => {
  const now = new Date('2026-06-13T12:00:00Z');

  it('returns null when there is no expiration', () => {
    expect(getExpiryStatus(undefined, now)).toBeNull();
  });

  it('returns null when expiration is more than 14 days away', () => {
    expect(getExpiryStatus('2026-12-01T00:00:00Z', now)).toBeNull();
  });

  it('returns expiring with day count within 14 days', () => {
    expect(getExpiryStatus('2026-06-18T12:00:00Z', now)).toEqual({ state: 'expiring', days: 5 });
  });

  it('returns expired for past dates', () => {
    expect(getExpiryStatus('2026-06-01T00:00:00Z', now)).toEqual({ state: 'expired' });
  });
});

describe('formatDate', () => {
  it('formats a valid ISO date', () => {
    expect(formatDate('2026-06-01T00:00:00Z')).toContain('2026');
  });

  it('returns an empty string for invalid input', () => {
    expect(formatDate('garbage')).toBe('');
  });
});

describe('DEFAULT_EXPIRY', () => {
  it('is 30 days', () => {
    expect(DEFAULT_EXPIRY).toBe('30');
  });
});
