import { Cron } from 'croner';
import type { TScheduleCadence } from './types/schedules';
import { isCronCadence, SCHEDULE_CRON_MAX_LENGTH } from './types/schedules';

/** Mirrors the server default when a weekly cadence omits `daysOfWeek`. */
const WEEKLY_DEFAULT_DAY = 1;

/**
 * Minute, hour, day of month, month, day of week. croner also reads a six-field form
 * carrying seconds and a seven-field form that pins a year, and both are refused.
 * Seconds would promise a precision the runtime does not keep: the engine polls on a
 * thirty-second tick and offsets each schedule by up to two minutes of jitter. A pinned
 * year makes a cadence that runs out, and every caller here treats "no next occurrence"
 * as a cadence it cannot read.
 */
const CRON_FIELD_COUNT = 5;

/**
 * Spring-forward compresses consecutive wall-clock occurrences, so the ENFORCEABLE
 * minimum for day-and-longer gaps is the nominal gap minus the largest real-world
 * transition: two hours (Antarctica/Troll; every other zone shifts at most one).
 * A floor set exactly at the nominal value would otherwise admit a schedule that
 * genuinely violates it once a year. Hourly gaps are unaffected (the skipped hours
 * lengthen, never shorten, the gap between occurrences).
 */
const DST_COMPRESSION_MINUTES = 120;

/**
 * Occurrences sampled when measuring a cron expression's tightest gap. The floor
 * exists to reject expressions that fire too OFTEN, and a dense pattern reveals
 * its short gap within the first few occurrences, so a small window answers the
 * question this guards. Known limit: this is a bounded probe, not the exhaustive
 * proof the structured formulas give. An expression that is sparse for the next
 * `CRON_PROBE_OCCURRENCES` runs and dense later would pass here and be caught by
 * the fire-time recheck instead.
 */
const CRON_PROBE_OCCURRENCES = 32;

/** Enough to span four nominal gaps from an anchor two gaps before a transition,
 *  which is what guarantees the straddling pair falls inside the window. */
const TRANSITION_PROBE_OCCURRENCES = 5;

/**
 * Compiles a cadence to the cron expression the engine fires from. Shared rather
 * than server-owned because the dialog previews the next runs, validates the
 * interval floor, and disables its own submit from these same functions: a second
 * client-side implementation would drift and either show run times the schedule
 * does not keep or accept a cadence the server then rejects.
 */
export function cadenceToCron(cadence: TScheduleCadence): string {
  if (cadence.frequency === 'cron') {
    return cadence.expression;
  }
  const { frequency, hour, minute } = cadence;
  if (frequency === 'hourly') {
    return `${minute} * * * *`;
  }
  if (frequency === 'daily') {
    return `${minute} ${hour} * * *`;
  }
  if (frequency === 'weekdays') {
    return `${minute} ${hour} * * 1-5`;
  }
  const days = cadence.daysOfWeek?.length ? cadence.daysOfWeek : [WEEKLY_DEFAULT_DAY];
  return `${minute} ${hour} * * ${[...days].sort((a, b) => a - b).join(',')}`;
}

/**
 * Everything `cronCadenceSchema` will accept: exactly five fields, within the length
 * the schema stores, and actually matching at some point. croner accepts syntactically
 * valid patterns that can never match (`0 0 30 2 *`), and those would arm a schedule
 * that never fires. Validated with croner rather than a regex, because a regex would
 * accept patterns croner then rejects at fire time.
 *
 * A five-field expression that matches at all matches forever, which is what lets every
 * caller keep reading "no next occurrence" as "this cadence is unreadable".
 */
export function isValidCronExpression(expression: string, timezone?: string): boolean {
  const trimmed = expression.trim();
  if (trimmed.length > SCHEDULE_CRON_MAX_LENGTH) {
    return false;
  }
  if (trimmed.split(/\s+/).length !== CRON_FIELD_COUNT) {
    return false;
  }
  try {
    return new Cron(trimmed, { timezone, paused: true }).nextRun() != null;
  } catch {
    return false;
  }
}

/**
 * The next occurrences the engine would fire. Server-side jitter (up to two
 * minutes) is deliberately not modelled: it is keyed off a schedule id that does
 * not exist yet at create time, and showing 9:01 for a 9:00 schedule reads as a bug.
 */
export function nextRunInstants(
  cadence: TScheduleCadence,
  timezone: string,
  count: number,
): Date[] {
  try {
    const runs = new Cron(cadenceToCron(cadence), { timezone, paused: true }).nextRuns(count);
    // At spring-forward croner folds the skipped wall-clock occurrences onto the
    // first valid instant, so consecutive entries can repeat (`0 2,3 * * *` in a US
    // zone yields 03:00 twice on the transition day). Those are one firing, which is
    // also how the engine's unique-occurrence index counts them; previewing the same
    // run twice reads as a bug.
    return runs.filter((run, index) => index === 0 || run.getTime() !== runs[index - 1].getTime());
  } catch {
    return [];
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A year and a bit, so a zone with a single yearly transition always shows one. */
const TRANSITION_SEARCH_DAYS = 400;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes east of UTC in `zone` at `instant`, read back from the wall clock the
 *  zone renders. The only way to observe a zone's offset without a tz database. */
function zoneOffsetMinutes(zone: string, instant: Date): number {
  let formatter = offsetFormatters.get(zone);
  if (formatter == null) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(zone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  const wallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((wallClock - instant.getTime()) / MINUTE_MS);
}

/** Zone transitions are asked for once per fire, and the scan below costs ~10ms.
 *  Keyed by day because that is how far the answer stays put as the window slides,
 *  and cleared wholesale at the cap so a long-lived worker cannot accumulate an
 *  entry per zone per day forever. */
const transitionCache = new Map<string, Date[]>();
const TRANSITION_CACHE_MAX = 512;

/**
 * Every instant `zone` changes its UTC offset within the search window; empty for a
 * fixed-offset zone. Both directions matter and only one of them shortens anything,
 * so taking just the next one would usually find the harmless fall-back and miss the
 * spring-forward six months behind it. Bracketed a day at a time, bisected to the
 * minute.
 */
function offsetChanges(zone: string, from: Date): Date[] {
  // Scanned from the keyed DAY BOUNDARY, not from `from` itself. The key already
  // discards everything below the day, so scanning from the exact instant let one
  // caller cache a list that omits a transition earlier the same day, and the next
  // caller that starts before it silently reused it and measured the nominal gap.
  const day = Math.floor(from.getTime() / DAY_MS);
  const cacheKey = `${zone}:${day}`;
  const cached = transitionCache.get(cacheKey);
  if (cached != null) {
    return cached;
  }
  const changes: Date[] = [];
  // Starts a day BEFORE the keyed one. Rounding forward to the anchor's own UTC day
  // excluded a transition on the preceding UTC date, which is where a southern-
  // hemisphere spring-forward lands: Australia/Sydney turns over at 16:00 UTC the day
  // before the local date it belongs to, so the gap it compressed went unmeasured.
  const start = new Date((day - 1) * DAY_MS);
  let low = start.getTime();
  let baseOffset = zoneOffsetMinutes(zone, start);
  const end = low + TRANSITION_SEARCH_DAYS * DAY_MS;
  for (let probe = low + DAY_MS; probe <= end; probe += DAY_MS) {
    const offset = zoneOffsetMinutes(zone, new Date(probe));
    if (offset !== baseOffset) {
      let high = probe;
      let bracket = low;
      while (high - bracket > MINUTE_MS) {
        const mid = bracket + Math.floor((high - bracket) / 2);
        if (zoneOffsetMinutes(zone, new Date(mid)) === baseOffset) {
          bracket = mid;
        } else {
          high = mid;
        }
      }
      changes.push(new Date(high));
      baseOffset = offset;
    }
    low = probe;
  }
  if (transitionCache.size >= TRANSITION_CACHE_MAX) {
    transitionCache.clear();
  }
  transitionCache.set(cacheKey, changes);
  return changes;
}

function runsAfter(
  expression: string,
  from: Date,
  zone: string,
  occurrences: number = CRON_PROBE_OCCURRENCES,
): Date[] {
  return new Cron(expression, { timezone: zone, paused: true }).nextRuns(occurrences, from);
}

/** Tightest gap, in minutes, across `runs`; null when there is no pair to measure. */
function minGapMinutes(runs: Date[]): number | null {
  if (runs.length < 2) {
    return null;
  }
  let minGapMs = Number.MAX_SAFE_INTEGER;
  for (let i = 1; i < runs.length; i++) {
    const gapMs = runs[i].getTime() - runs[i - 1].getTime();
    // At spring-forward croner folds the wall-clock hours that do not exist onto the
    // one that replaced them, so the sequence can repeat an instant or step backwards
    // (Antarctica/Troll skips two hours and reported a gap of -60). Those are one
    // firing, which is also how the engine's unique-occurrence index counts them;
    // treating them as gaps reported every hourly cron in a DST zone as unschedulable.
    // Only non-positive gaps are dropped: a sub-minute gap is real and still floors to 0.
    if (gapMs <= 0) {
      continue;
    }
    minGapMs = Math.min(minGapMs, gapMs);
  }
  if (minGapMs === Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return Math.floor(minGapMs / MINUTE_MS);
}

function probeMinGapMinutes(
  expression: string,
  zone: string,
  from: Date,
  occurrences: number = CRON_PROBE_OCCURRENCES,
): number | null {
  return minGapMinutes(runsAfter(expression, from, zone, occurrences));
}

/**
 * Smallest gap in minutes between occurrences. Returns 0 for an unparseable or
 * never-matching expression so every floor rejects it, failing closed rather than
 * admitting an expression the engine cannot fire.
 *
 * Measured twice, and the smaller wins:
 *
 * 1. Nominal, probed in UTC, then discounted by the same worst-case DST allowance
 *    the structured branches assume. This keeps `0 9 * * *` reporting exactly what
 *    the Daily preset reports, so the same schedule cannot be admitted in one form
 *    and rejected in the other.
 * 2. Real elapsed time in the schedule's own zone, across each of that zone's
 *    transitions. Spring-forward compresses a gap that straddles one
 *    (`0 0,12 * * *` in America/New_York is 11 hours that day, not 12), and step 1
 *    only discounts gaps of a day or more, so a subdaily gap needs measuring rather
 *    than estimating. Anchoring at the transition is what makes a bounded probe see
 *    it at all: from today it is usually months outside any reasonable window.
 */
function cronIntervalMinutes(expression: string, timezone?: string): number {
  try {
    const now = new Date();
    const nominal = probeMinGapMinutes(expression, 'UTC', now);
    if (nominal == null) {
      // The expression can never match at all, so it must fail every floor.
      return 0;
    }
    // Spring-forward can only compress a gap that spans the transition, so the
    // blanket allowance applies from a day up. Taking it off an hourly gap too
    // would reject `0 * * * *` against a 60-minute floor while Hourly passed.
    const estimate = nominal < 24 * 60 ? nominal : Math.max(0, nominal - DST_COMPRESSION_MINUTES);
    if (timezone == null || estimate === 0) {
      return estimate;
    }
    // Sized off the nominal gap rather than fixed: starting two gaps before the
    // transition and taking five occurrences spans at least four of them, so the
    // straddling pair is always inside the window. A fixed one-day anchor with 32
    // occurrences both overshot a sparse expression and, for a dense one, never
    // reached the transition at all (32 minutes in, for `* * * * *`).
    const anchorBackMs = 2 * Math.max(nominal, 1) * MINUTE_MS;
    let smallest = estimate;
    for (const transition of offsetChanges(timezone, now)) {
      const measured = probeMinGapMinutes(
        expression,
        timezone,
        // Clamped forward: the pair straddling a future transition still falls inside
        // the window, while occurrences already behind the caller stay out of it.
        new Date(Math.max(now.getTime(), transition.getTime() - anchorBackMs)),
        TRANSITION_PROBE_OCCURRENCES,
      );
      if (measured != null) {
        smallest = Math.min(smallest, measured);
      }
    }
    return smallest;
  } catch {
    return 0;
  }
}

/**
 * Minimum minutes between occurrences, for the admin interval floor. `timezone` is
 * the schedule's own; passing it lets the cron branch measure a DST-compressed gap
 * instead of estimating one. The structured branches are zone-independent: their
 * formulas already carry the worst-case allowance.
 */
export function cadenceIntervalMinutes(cadence: TScheduleCadence, timezone?: string): number {
  if (isCronCadence(cadence)) {
    return cronIntervalMinutes(cadence.expression, timezone);
  }
  if (cadence.frequency === 'hourly') {
    return 60;
  }
  if (cadence.frequency === 'daily' || cadence.frequency === 'weekdays') {
    return 24 * 60 - DST_COMPRESSION_MINUTES;
  }
  // Deduped defensively: the payload schema normalizes new writes, but a legacy
  // stored [1, 1] would otherwise read as a zero-day gap and fail every floor.
  const days = cadence.daysOfWeek?.length
    ? Array.from(new Set(cadence.daysOfWeek))
    : [WEEKLY_DEFAULT_DAY];
  if (days.length <= 1) {
    return 7 * 24 * 60 - DST_COMPRESSION_MINUTES;
  }
  // The interval floor must reflect the SHORTEST gap between selected days
  // (incl. the week wrap-around), e.g. [Mon, Tue] fires 24h apart, so it must be
  // rejected against a >1440-minute floor.
  const sorted = [...days].sort((a, b) => a - b);
  let minGapDays = 7;
  for (let i = 0; i < sorted.length; i++) {
    const gap = i + 1 < sorted.length ? sorted[i + 1] - sorted[i] : 7 - sorted[i] + sorted[0];
    minGapDays = Math.min(minGapDays, gap);
  }
  return minGapDays * 24 * 60 - DST_COMPRESSION_MINUTES;
}
