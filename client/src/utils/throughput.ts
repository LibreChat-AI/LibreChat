/** One reading of the live output-token estimate, taken when the stream flushes. */
export interface ThroughputSample {
  at: number;
  tokens: number;
}

/** Settled figures for one completed response, kept for the session only. */
export interface SettledThroughput {
  responseId: string;
  outputTokens: number;
  /** First delta to last delta, so provider latency before output is excluded. */
  durationMs: number;
  /** Pre-invoke snapshot to first delta; null when no snapshot preceded the call. */
  ttftMs: number | null;
  /** True when no provider usage confirmed the output and the count is a char estimate. */
  estimated: boolean;
}

/** Trailing span the live rate averages over. */
export const THROUGHPUT_WINDOW_MS = 2000;
/** Samples retained per conversation: a few windows at the 250 ms flush cadence. */
export const THROUGHPUT_MAX_SAMPLES = 64;
/** Sparkline history retained by the live indicator. */
export const THROUGHPUT_HISTORY_LENGTH = 40;

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0;

/** Appends to a bounded list, dropping the oldest entries past `max`. */
export function appendBounded<T>(items: readonly T[], item: T, max: number): T[] {
  const next = items.length >= max ? items.slice(items.length - max + 1) : items.slice();
  next.push(item);
  return next;
}

/**
 * Tokens per second over the trailing window, measured against `now` rather
 * than the latest sample so a paused stream (a tool call, a stall) decays to
 * zero instead of holding the last burst. The baseline is the newest sample at
 * or before the window start, or the oldest sample when the stream is younger
 * than one window.
 */
export function windowedRate(
  samples: readonly ThroughputSample[],
  now: number,
  windowMs = THROUGHPUT_WINDOW_MS,
): number {
  if (samples.length < 2) {
    return 0;
  }
  const latest = samples[samples.length - 1];
  const windowStart = now - windowMs;
  if (latest.at <= windowStart) {
    return 0;
  }
  let baseline = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (samples[i].at <= windowStart) {
      baseline = samples[i];
      break;
    }
  }
  const elapsedMs = Math.max(now, latest.at) - baseline.at;
  if (elapsedMs <= 0) {
    return 0;
  }
  return finiteNonNegative(((latest.tokens - baseline.tokens) * 1000) / elapsedMs);
}

/** Mean tokens per second for a completed response. */
export function averageRate(outputTokens: number, durationMs: number): number {
  if (durationMs <= 0) {
    return 0;
  }
  return finiteNonNegative((outputTokens * 1000) / durationMs);
}

/** One decimal below ten tokens per second, whole numbers above. */
export function formatRate(rate: number): string {
  const value = finiteNonNegative(rate);
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/** Seconds with one decimal, for TTFT and duration readings. */
export function formatSeconds(ms: number): string {
  return (finiteNonNegative(ms) / 1000).toFixed(1);
}

/**
 * SVG polyline points for a rate history, scaled to the given box. The
 * vertical scale follows the history's own peak so a slow model still fills
 * the sparkline; a flat history draws along the baseline.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) {
    return '';
  }
  const peak = values.reduce((max, value) => Math.max(max, finiteNonNegative(value)), 0);
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const points: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const ratio = peak > 0 ? finiteNonNegative(values[i]) / peak : 0;
    const x = (i * stepX).toFixed(1);
    const y = (height - ratio * height).toFixed(1);
    points.push(`${x},${y}`);
  }
  return points.join(' ');
}
