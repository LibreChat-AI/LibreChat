import {
  parseRefillAnchor,
  getNextRefillDate,
  isBalanceRefillDue,
  getAnchoredBoundaryAfter,
} from '../src/balance';
import type { RefillIntervalUnit } from '../src/balance';

const at = (iso: string) => new Date(iso);
const boundary = (after: string, anchor: string, value: number, unit: RefillIntervalUnit) => {
  const parsed = parseRefillAnchor(anchor);
  if (parsed == null) {
    throw new Error(`invalid anchor ${anchor}`);
  }
  return getAnchoredBoundaryAfter(at(after), parsed, value, unit)?.toISOString() ?? null;
};

describe('parseRefillAnchor', () => {
  test.each([
    ['2026-01-05T00:00:00Z', Date.parse('2026-01-05T00:00:00Z'), 0],
    ['2026-01-05T00:00Z', Date.parse('2026-01-05T00:00:00Z'), 0],
    ['2026-01-05T00:00:00.250Z', Date.parse('2026-01-05T00:00:00.250Z'), 0],
    ['2026-01-05T00:00:00-05:00', Date.parse('2026-01-05T05:00:00Z'), -5 * 3_600_000],
    ['2026-01-05T09:30:00+05:30', Date.parse('2026-01-05T04:00:00Z'), 5.5 * 3_600_000],
  ])('reads %s', (anchor, time, offsetMs) => {
    expect(parseRefillAnchor(anchor)).toEqual({ time, offsetMs });
  });

  test.each([
    '2026-01-05T00:00:00',
    '2026-01-05',
    '2026-02-30T00:00:00Z',
    '2026-01-05T24:00:00Z',
    '2026-01-05T00:00:00+15:00',
    'next monday',
    '',
  ])('rejects %s', (anchor) => {
    expect(parseRefillAnchor(anchor)).toBeNull();
  });
});

describe('getAnchoredBoundaryAfter', () => {
  const monday = '2026-01-05T00:00:00Z';

  test('lands on the next anchored weekday', () => {
    expect(boundary('2026-11-14T12:00:00Z', monday, 1, 'weeks')).toBe('2026-11-16T00:00:00.000Z');
  });

  test('starts the following period when called exactly on a boundary', () => {
    expect(boundary('2026-11-16T00:00:00Z', monday, 1, 'weeks')).toBe('2026-11-23T00:00:00.000Z');
  });

  test('steps whole multi-unit intervals from the anchor', () => {
    expect(boundary('2026-11-14T12:00:00Z', monday, 2, 'weeks')).toBe('2026-11-23T00:00:00.000Z');
    expect(boundary('2026-11-24T12:00:00Z', monday, 2, 'weeks')).toBe('2026-12-07T00:00:00.000Z');
  });

  test('works backwards from an anchor in the future', () => {
    expect(boundary('2026-11-14T12:00:00Z', '2027-01-04T00:00:00Z', 1, 'weeks')).toBe(
      '2026-11-16T00:00:00.000Z',
    );
  });

  test('aligns days and hours to the anchor time of day', () => {
    expect(boundary('2026-11-14T12:00:00Z', '2026-01-01T06:00:00Z', 1, 'days')).toBe(
      '2026-11-15T06:00:00.000Z',
    );
    expect(boundary('2026-11-14T12:20:00Z', '2026-01-01T00:30:00Z', 1, 'hours')).toBe(
      '2026-11-14T12:30:00.000Z',
    );
  });

  test('falls back to the last day of shorter months without drifting', () => {
    const endOfMonth = '2026-01-31T00:00:00Z';
    expect(boundary('2026-02-10T00:00:00Z', endOfMonth, 1, 'months')).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(boundary('2026-02-28T00:00:00Z', endOfMonth, 1, 'months')).toBe(
      '2026-03-31T00:00:00.000Z',
    );
    expect(boundary('2028-02-01T00:00:00Z', endOfMonth, 1, 'months')).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  test('reads monthly boundaries on the anchor offset wall clock', () => {
    const newYork = '2026-01-01T00:00:00-05:00';
    expect(boundary('2026-03-01T04:00:00Z', newYork, 1, 'months')).toBe('2026-03-01T05:00:00.000Z');
    expect(boundary('2026-03-01T05:00:00Z', newYork, 1, 'months')).toBe('2026-04-01T05:00:00.000Z');
  });

  test('steps multi-month intervals from an earlier anchor', () => {
    expect(boundary('2026-11-14T00:00:00Z', '2026-01-01T00:00:00Z', 3, 'months')).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(boundary('2026-11-14T00:00:00Z', '2027-06-01T00:00:00Z', 3, 'months')).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });

  test.each([0, -1, 1.5])('has no boundary for interval %s', (value) => {
    expect(boundary('2026-11-14T00:00:00Z', monday, value, 'weeks')).toBeNull();
  });
});

describe('anchored refill schedule', () => {
  const weekly = {
    autoRefillEnabled: true,
    refillAmount: 1000,
    refillMode: 'reset' as const,
    refillIntervalValue: 1,
    refillIntervalUnit: 'weeks' as const,
    refillAnchor: '2026-01-05T00:00:00Z',
    lastRefill: '2026-11-14T12:00:00Z',
  };

  test('is due at the next anchored boundary, not a full interval after the last refill', () => {
    expect(isBalanceRefillDue(weekly, at('2026-11-15T23:59:59Z'))).toBe(false);
    expect(isBalanceRefillDue(weekly, at('2026-11-16T00:00:00Z'))).toBe(true);
    expect(getNextRefillDate(weekly)?.toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  test('grants one period after missed boundaries, then waits for the next one', () => {
    const idle = { ...weekly, lastRefill: '2026-09-01T00:00:00Z' };
    expect(isBalanceRefillDue(idle, at('2026-11-17T10:00:00Z'))).toBe(true);
    const reset = { ...weekly, lastRefill: '2026-11-17T10:00:00Z' };
    expect(isBalanceRefillDue(reset, at('2026-11-22T23:00:00Z'))).toBe(false);
    expect(getNextRefillDate(reset)?.toISOString()).toBe('2026-11-23T00:00:00.000Z');
  });

  test('keeps rolling periods without an anchor', () => {
    const rolling = { ...weekly, refillAnchor: null };
    expect(isBalanceRefillDue(rolling, at('2026-11-16T00:00:00Z'))).toBe(false);
    expect(getNextRefillDate(rolling)?.toISOString()).toBe('2026-11-21T12:00:00.000Z');
  });

  test('applies the anchor to additive refills', () => {
    const additive = { ...weekly, refillMode: 'add' as const };
    expect(isBalanceRefillDue(additive, at('2026-11-15T00:00:00Z'))).toBe(false);
    expect(isBalanceRefillDue(additive, at('2026-11-16T00:00:00Z'))).toBe(true);
  });

  test('never refills an anchored record whose interval cannot form boundaries', () => {
    const fractional = { ...weekly, refillMode: 'add' as const, refillIntervalValue: 0.5 };
    expect(isBalanceRefillDue(fractional, at('2027-01-01T00:00:00Z'))).toBe(false);
  });
});
