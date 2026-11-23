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

const UNIT_MS: Record<Exclude<RefillIntervalUnit, 'months'>, number> = {
  seconds: 1000,
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

const ANCHOR_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** A reset anchor's instant and the fixed UTC offset its calendar fields are read in. */
export interface RefillAnchor {
  time: number;
  offsetMs: number;
}

/**
 * Parses an ISO 8601 timestamp with an explicit `Z` or `±HH:MM` offset. Null for anything else,
 * including timestamps without an offset, whose meaning would depend on the server's time zone.
 */
export function parseRefillAnchor(anchor: string | null | undefined): RefillAnchor | null {
  const match = anchor == null ? null : ANCHOR_PATTERN.exec(anchor);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, millis, , sign, offsetHours, offsetMinutes] =
    match;
  const offsetMs =
    sign == null
      ? 0
      : (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60 * 1000;
  const wall = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
    Number((millis ?? '0').padEnd(3, '0')),
  );
  const check = new Date(wall);
  if (
    Number.isNaN(wall) ||
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second ?? 0) > 59 ||
    Math.abs(offsetMs) > 14 * 60 * 60 * 1000
  ) {
    return null;
  }
  return { time: wall - offsetMs, offsetMs };
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** The `k`th monthly boundary from the anchor, read on the anchor's wall clock; a day the month
 *  lacks falls back to its last day. */
function monthlyBoundary(anchor: RefillAnchor, months: number): number {
  const wall = new Date(anchor.time + anchor.offsetMs);
  const index = wall.getUTCFullYear() * 12 + wall.getUTCMonth() + months;
  const year = Math.floor(index / 12);
  const monthIndex = index - year * 12;
  const day = Math.min(wall.getUTCDate(), daysInMonth(year, monthIndex));
  return (
    Date.UTC(
      year,
      monthIndex,
      day,
      wall.getUTCHours(),
      wall.getUTCMinutes(),
      wall.getUTCSeconds(),
      wall.getUTCMilliseconds(),
    ) - anchor.offsetMs
  );
}

/**
 * The first period boundary strictly after `after`, where boundaries fall on the anchor plus
 * whole intervals in either direction. Null for a non-positive or fractional interval.
 */
export function getAnchoredBoundaryAfter(
  after: Date,
  anchor: RefillAnchor,
  value: number,
  unit: RefillIntervalUnit,
): Date | null {
  if (!(Number.isInteger(value) && value > 0)) {
    return null;
  }
  const from = after.getTime();
  if (unit !== 'months') {
    const step = value * UNIT_MS[unit];
    const k = Math.floor((from - anchor.time) / step) + 1;
    return new Date(anchor.time + k * step);
  }
  const wall = new Date(from + anchor.offsetMs);
  const anchorWall = new Date(anchor.time + anchor.offsetMs);
  const elapsed =
    (wall.getUTCFullYear() - anchorWall.getUTCFullYear()) * 12 +
    (wall.getUTCMonth() - anchorWall.getUTCMonth());
  let k = Math.floor(elapsed / value);
  while (monthlyBoundary(anchor, k * value) <= from) {
    k++;
  }
  while (monthlyBoundary(anchor, (k - 1) * value) > from) {
    k--;
  }
  return new Date(monthlyBoundary(anchor, k * value));
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

/**
 * The credits the current period was granted, or null when none is stored, the period start is
 * unknown, or a refill since (by a server that predates the field) left it describing an earlier
 * period.
 */
export function getGrantedAllotment(
  record: Pick<TBalanceResponse, 'allotment' | 'allottedAt' | 'lastRefill'>,
): number | null {
  const { allotment, allottedAt, lastRefill } = record;
  if (allotment == null || !(allotment > 0) || allottedAt == null) {
    return null;
  }
  const granted = new Date(allottedAt).getTime();
  if (Number.isNaN(granted)) {
    return null;
  }
  const refilled = lastRefill == null ? NaN : new Date(lastRefill).getTime();
  return Number.isNaN(refilled) || granted < refilled ? null : allotment;
}

type RefillSchedule = Pick<
  TBalanceResponse,
  'lastRefill' | 'refillIntervalValue' | 'refillIntervalUnit' | 'refillAnchor'
>;

/**
 * When the period that started at `lastRefill` ends: the next anchored boundary when the record
 * has a valid anchor, else `lastRefill` plus one interval. Null without a readable `lastRefill`,
 * or for an anchor with an interval no boundary can be built from.
 */
export function getNextRefillDate(record: RefillSchedule): Date | null {
  const { lastRefill, refillIntervalValue, refillIntervalUnit } = record;
  if (lastRefill == null || refillIntervalValue == null || refillIntervalUnit == null) {
    return null;
  }
  const last = new Date(lastRefill);
  if (Number.isNaN(last.getTime())) {
    return null;
  }
  const anchor = parseRefillAnchor(record.refillAnchor);
  if (anchor != null) {
    return getAnchoredBoundaryAfter(last, anchor, refillIntervalValue, refillIntervalUnit);
  }
  return getRefillEligibilityDate(last, refillIntervalValue, refillIntervalUnit);
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
    | 'refillAnchor'
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
  const anchor = parseRefillAnchor(record.refillAnchor);
  if (anchor != null) {
    const boundary = getAnchoredBoundaryAfter(
      lastRefill,
      anchor,
      record.refillIntervalValue ?? 0,
      record.refillIntervalUnit ?? 'days',
    );
    return boundary != null && now >= boundary;
  }
  const eligibleAt = getRefillEligibilityDate(
    lastRefill,
    record.refillIntervalValue ?? 0,
    record.refillIntervalUnit ?? 'days',
  );
  // Date setters can round a fractional interval down to the same instant.
  return (record.refillMode !== 'reset' || eligibleAt > lastRefill) && now >= eligibleAt;
}
