import type { TBalanceResponse } from './types';

export const REFILL_INTERVAL_UNITS = [
  'seconds',
  'minutes',
  'hours',
  'days',
  'weeks',
  'months',
] as const;

export const BALANCE_REFILL_MODES = ['add', 'reset'] as const;

export type BalanceRefillMode = (typeof BALANCE_REFILL_MODES)[number];

export type RefillIntervalUnit = (typeof REFILL_INTERVAL_UNITS)[number];

/** How the UI presents a balance: raw credits, their currency value, or the share of the
 *  period's allotment already spent. */
export const BALANCE_DISPLAY_MODES = ['credits', 'currency', 'percent'] as const;

export type BalanceDisplay = (typeof BALANCE_DISPLAY_MODES)[number];

/** Token credits per US dollar: transaction rates are USD per million tokens. */
export const CREDITS_PER_USD = 1_000_000;

/** How long an unreleased in-flight balance reservation keeps counting against the balance. */
export const DEFAULT_BALANCE_RESERVATION_TTL_MS = 30 * 60 * 1000;
/** Shortest reservation TTL; a live reservation is renewed every half TTL. */
export const MIN_BALANCE_RESERVATION_TTL_MS = 10 * 1000;

function ensureExhaustive(value: never): void {
  void value;
}

export function getRefillEligibilityDate(
  lastRefill: Date,
  value: number,
  unit: RefillIntervalUnit,
): Date {
  const result = new Date(lastRefill);
  switch (unit) {
    case 'seconds':
      result.setSeconds(result.getSeconds() + value);
      return result;
    case 'minutes':
      result.setMinutes(result.getMinutes() + value);
      return result;
    case 'hours':
      result.setHours(result.getHours() + value);
      return result;
    case 'days':
      result.setDate(result.getDate() + value);
      return result;
    case 'weeks':
      result.setDate(result.getDate() + value * 7);
      return result;
    case 'months':
      result.setMonth(result.getMonth() + value);
      return result;
    default: {
      ensureExhaustive(unit);
      return result;
    }
  }
}

/** Whether the configured refill/reset period has elapsed. */
export function isBalanceRefillDue(
  record: Pick<
    TBalanceResponse,
    | 'refillMode'
    | 'autoRefillEnabled'
    | 'refillAmount'
    | 'lastRefill'
    | 'refillIntervalValue'
    | 'refillIntervalUnit'
  >,
  now: Date,
): boolean {
  if (!record.autoRefillEnabled || !(record.refillAmount != null && record.refillAmount > 0)) {
    return false;
  }
  if (
    record.refillMode === 'reset' &&
    !(
      record.refillIntervalValue != null &&
      Number.isInteger(record.refillIntervalValue) &&
      record.refillIntervalValue > 0
    )
  ) {
    return false;
  }
  const lastRefill = new Date(record.lastRefill ?? 0);
  if (isNaN(lastRefill.getTime())) {
    return true;
  }
  const eligibleAt = getRefillEligibilityDate(
    lastRefill,
    record.refillIntervalValue ?? 0,
    record.refillIntervalUnit ?? 'days',
  );
  // Date setters can round a fractional interval down to the same instant.
  return (record.refillMode !== 'reset' || eligibleAt > lastRefill) && now >= eligibleAt;
}
