import { CREDITS_PER_USD, getRefillEligibilityDate } from 'librechat-data-provider';
import type { BalanceDisplay, TBalanceResponse } from 'librechat-data-provider';
import type { CurrencyConfig } from './tokens';
import { formatCost } from './tokens';

/** Share of the allotment spent at which the balance reads as running low. */
export const BALANCE_WARNING_PERCENT = 90;

export type BalanceTone = 'normal' | 'warning' | 'danger';

/**
 * One reading of the user's balance. Every surface that shows the balance renders
 * from this, so the gauge popover and the settings dialog cannot disagree.
 */
export interface BalanceSummary {
  display: BalanceDisplay;
  credits: number;
  /** Credits one period grants: the refill amount under auto-refill, else the starting balance. */
  allotment: number | null;
  /** Whole percent of the allotment spent, 0–100; 100 once credits run out, else null without
   *  an allotment to measure against. */
  usedPercent: number | null;
  tone: BalanceTone;
  /** Credits the next auto-refill adds; null without auto-refill. */
  refillAmount: number | null;
  /** When the next auto-refill becomes eligible; null without auto-refill. */
  nextRefill: Date | null;
}

interface SummaryOptions {
  display?: BalanceDisplay;
  startBalance?: number;
}

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

function getNextRefill(balance: TBalanceResponse): Date | null {
  const { lastRefill, refillIntervalValue, refillIntervalUnit } = balance;
  if (lastRefill == null || refillIntervalValue == null || refillIntervalUnit == null) {
    return null;
  }
  const last = new Date(lastRefill);
  if (Number.isNaN(last.getTime())) {
    return null;
  }
  return getRefillEligibilityDate(last, refillIntervalValue, refillIntervalUnit);
}

/**
 * Percent spent is floored while credits remain, so a nearly drained balance never
 * reads "100% used" before it is actually empty; an empty balance is fully spent
 * whatever it is measured against.
 */
function getUsedPercent(credits: number, allotment: number | null): number | null {
  if (credits <= 0) {
    return 100;
  }
  if (allotment == null) {
    return null;
  }
  const spent = (1 - credits / allotment) * 100;
  return Math.min(Math.max(Math.floor(spent), 0), 99);
}

export function summarizeBalance(
  balance: TBalanceResponse,
  { display = 'credits', startBalance }: SummaryOptions = {},
): BalanceSummary {
  const credits = Number.isFinite(balance.tokenCredits) ? balance.tokenCredits : 0;
  const refillAmount = balance.autoRefillEnabled ? positive(balance.refillAmount) : null;
  const allotment = refillAmount ?? positive(startBalance);
  const usedPercent = getUsedPercent(credits, allotment);

  let tone: BalanceTone = 'normal';
  if (credits <= 0) {
    tone = 'danger';
  } else if (usedPercent != null && usedPercent >= BALANCE_WARNING_PERCENT) {
    tone = 'warning';
  }

  return {
    display,
    credits,
    allotment,
    usedPercent,
    tone,
    refillAmount,
    nextRefill: balance.autoRefillEnabled ? getNextRefill(balance) : null,
  };
}

/** A credit amount in the configured display: money for `currency`, whole credits otherwise. */
export function formatBalanceAmount(
  credits: number,
  display: BalanceDisplay,
  currency?: CurrencyConfig,
): string {
  if (display === 'currency') {
    return formatCost(credits / CREDITS_PER_USD, currency);
  }
  /** Credits are fractional when pricing multipliers are; two places keep a shortfall like
   *  100.4 against 100.3 visible, and whole amounts still print without decimals */
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(credits);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "in 5 minutes" / "in 3 hours" / "in 4 days"; null once the moment has passed. */
export function formatTimeUntil(target: Date, now: number, locale?: string): string | null {
  const remaining = target.getTime() - now;
  if (!(remaining > 0)) {
    return null;
  }
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  if (remaining < HOUR_MS) {
    return format.format(Math.max(1, Math.ceil(remaining / MINUTE_MS)), 'minute');
  }
  if (remaining < 2 * DAY_MS) {
    return format.format(Math.ceil(remaining / HOUR_MS), 'hour');
  }
  return format.format(Math.ceil(remaining / DAY_MS), 'day');
}
