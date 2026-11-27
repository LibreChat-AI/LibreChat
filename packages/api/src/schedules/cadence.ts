import { Cron } from 'croner';
import {
  cadenceToCron,
  cadenceIntervalMinutes,
  isValidCronExpression,
} from 'librechat-data-provider';
import type { TScheduleCadence } from 'librechat-data-provider';

export const SCHEDULE_JITTER_WINDOW_MS = 120_000;

/**
 * Cadence compilation and the interval floor live in `librechat-data-provider` so
 * the dialog validates against the exact rules this engine enforces. Re-exported
 * here to keep the engine's imports pointed at one schedules module.
 */
export { cadenceToCron, cadenceIntervalMinutes, isValidCronExpression };

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic per-schedule jitter so fleet-wide fire spikes (everyone at
 * 9:00) spread across a window while each schedule's displayed next-run time
 * stays stable across recomputations.
 */
export function scheduleJitterMs(
  scheduleId: string,
  windowMs: number = SCHEDULE_JITTER_WINDOW_MS,
): number {
  let hash = 5381;
  for (let i = 0; i < scheduleId.length; i++) {
    hash = ((hash << 5) + hash + scheduleId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % windowMs;
}

export interface ComputeNextRunParams {
  cadence: TScheduleCadence;
  timezone: string;
  scheduleId: string;
  /** Occurrences at or before this instant are skipped (misfire skip-forward). */
  after?: Date;
  disableJitter?: boolean;
}

/**
 * Next fire instant strictly after `after` (default now), jitter applied.
 * DST semantics are croner's behavior (locked by cadence.spec.ts): a
 * spring-forward gap occurrence fires shifted to the first valid instant
 * (02:30 → 03:30); fall-back ambiguity fires the first occurrence only.
 */
export function computeNextRunAt(params: ComputeNextRunParams): Date | null {
  // A malformed stored schedule (e.g. an invalid timezone inserted before
  // validation or by an admin script) makes croner throw at construction. Treat
  // an uncomputable next run as null — the same signal as "no future occurrence"
  // — so the engine disables it (`invalid_schedule`) rather than throwing out of
  // a tick every time the lease expires and starving other due schedules.
  try {
    const cron = new Cron(cadenceToCron(params.cadence), {
      timezone: params.timezone,
      paused: true,
    });
    const base = params.after ?? new Date();
    const jitter = params.disableJitter === true ? 0 : scheduleJitterMs(params.scheduleId);
    // The jittered instant is `cronOccurrence + jitter`. To return the first one
    // strictly after `base`, find the first cron occurrence after `base - jitter`
    // (occurrence O > base - jitter ⇒ O + jitter > base). Querying from `base`
    // directly would skip an occurrence whose jittered time is still in the future
    // but whose unjittered time already passed (e.g. an hourly :00 created at
    // 12:00:30 with 90s jitter must fire at 12:01:30, not 13:01:30).
    const next = cron.nextRun(new Date(base.getTime() - jitter));
    if (next == null) {
      return null;
    }
    return new Date(next.getTime() + jitter);
  } catch {
    return null;
  }
}
