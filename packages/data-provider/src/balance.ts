export const REFILL_INTERVAL_UNITS = [
  'seconds',
  'minutes',
  'hours',
  'days',
  'weeks',
  'months',
] as const;

export type RefillIntervalUnit = (typeof REFILL_INTERVAL_UNITS)[number];

/** Existing balance currency: 1,000 token credits equal $0.001 USD. */
export const TOKEN_CREDITS_PER_USD = 1_000_000;

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
