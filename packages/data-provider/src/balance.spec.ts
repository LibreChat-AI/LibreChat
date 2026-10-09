import { getRefillEligibilityDate } from './balance';
import type { RefillIntervalUnit } from './balance';

describe('getRefillEligibilityDate', () => {
  it.each([
    ['seconds', 30, '2026-05-05T16:00:30.000Z'],
    ['minutes', 15, '2026-05-05T16:15:00.000Z'],
    ['hours', 2, '2026-05-05T18:00:00.000Z'],
    ['days', 1, '2026-05-06T16:00:00.000Z'],
    ['weeks', 1, '2026-05-12T16:00:00.000Z'],
    ['months', 1, '2026-06-05T16:00:00.000Z'],
  ] as const)(
    'returns lastRefill plus %s for the refill eligibility date',
    (unit: RefillIntervalUnit, value: number, expected: string) => {
      const lastRefill = new Date('2026-05-05T16:00:00.000Z');

      expect(getRefillEligibilityDate(lastRefill, value, unit)).toEqual(new Date(expected));
    },
  );

  it('computes eligibility from an old lastRefill without considering current time', () => {
    const lastRefill = new Date('2026-05-03T16:00:00.000Z');

    expect(getRefillEligibilityDate(lastRefill, 1, 'days')).toEqual(
      new Date('2026-05-04T16:00:00.000Z'),
    );
  });

  it('returns the last refill date for a zero-value interval', () => {
    const lastRefill = new Date('2026-05-05T16:00:00.000Z');

    expect(getRefillEligibilityDate(lastRefill, 0, 'days')).toEqual(lastRefill);
  });

  it('documents JavaScript month-end rollover behavior', () => {
    const lastRefill = new Date('2026-01-31T12:00:00.000Z');

    expect(getRefillEligibilityDate(lastRefill, 1, 'months')).toEqual(
      new Date('2026-03-03T12:00:00.000Z'),
    );
  });

  it('returns a Date fallback for unknown runtime interval units', () => {
    const lastRefill = new Date('2026-05-05T16:00:00.000Z');
    const unknownUnit = 'years' as unknown as RefillIntervalUnit;

    expect(getRefillEligibilityDate(lastRefill, 1, unknownUnit)).toEqual(lastRefill);
  });
});
