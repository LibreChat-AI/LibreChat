import type Result from 'lighthouse/types/lhr/lhr.js';

import type { Budgets } from './budgets.mts';

/**
 * Lighthouse's CPU benchmark score on the hosted runners the budgets are calibrated against.
 * Blocking time is restated at this speed: one build has measured 613, 191 and 159 ms of it in
 * three consecutive runs, and the benchmark moves with whatever else the runner is doing.
 */
export const REFERENCE_BENCHMARK_INDEX = 2750;

/** Only the part of a main-thread task that runs past this blocks input. */
const BLOCKING_THRESHOLD_MS = 50;

const BLOCKING_AUDIT = 'total-blocking-time';

export interface Task {
  startTime: number;
  duration: number;
}

/** First contentful paint to time to interactive, in ms after navigation start. */
export interface Window {
  start: number;
  end: number;
}

export interface Measurement {
  audit: string;
  statistic: string;
  value: number;
  limit: number;
}

/**
 * Total blocking time with every task `cpuScale` times as long. At a scale of 1 this is
 * Lighthouse's own sum: each task's tail past the threshold, clipped to the window.
 */
export function blockingTime(tasks: Task[], window: Window, cpuScale = 1): number {
  let total = 0;
  for (const { startTime, duration } of tasks) {
    const blocking = duration * cpuScale - BLOCKING_THRESHOLD_MS;
    if (blocking <= 0) continue;
    // A task too short to block on this runner has no tail, so its whole span stands in.
    const tail = duration > BLOCKING_THRESHOLD_MS ? duration - BLOCKING_THRESHOLD_MS : duration;
    const end = startTime + duration;
    const counted = Math.min(end, window.end) - Math.max(end - tail, window.start);
    if (counted > 0) total += blocking * (counted / tail);
  }
  return total;
}

/** One run's blocking time as the reference CPU would have measured it. */
export function referenceBlockingTime(report: Result): number {
  const tasks = report.audits['main-thread-tasks']?.details;
  const start = report.audits['first-contentful-paint']?.numericValue;
  const end = report.audits['interactive']?.numericValue;
  const benchmarkIndex = report.environment?.benchmarkIndex;
  if (
    tasks?.type !== 'table' ||
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    typeof benchmarkIndex !== 'number' ||
    benchmarkIndex <= 0
  ) {
    throw new Error(
      'Lighthouse reported no main-thread tasks, paint window or CPU benchmark; check `main-thread-tasks`, `first-contentful-paint`, `interactive` and `environment.benchmarkIndex`.',
    );
  }
  return blockingTime(
    tasks.items.map((item) => ({
      startTime: Number(item.startTime),
      duration: Number(item.duration),
    })),
    { start, end },
    benchmarkIndex / REFERENCE_BENCHMARK_INDEX,
  );
}

function median(results: Result[], audit: string): number {
  const values = results
    .map((report) => report.audits[audit]?.numericValue)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  if (!values.length || values.length !== results.length) {
    throw new Error(`Lighthouse must report a numeric ${audit} for every run`);
  }
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/**
 * Blocking time takes the lowest run rather than the median: a busy runner only ever adds
 * blocking time, so the quietest run is the closest to what the page itself costs.
 */
export function measure(results: Result[], budgets: Budgets): Measurement[] {
  return Object.entries(budgets).map(([audit, limit]) => {
    if (audit !== BLOCKING_AUDIT) {
      return { audit, statistic: 'median', value: median(results, audit), limit };
    }
    if (!results.length) {
      throw new Error(`Lighthouse must report a numeric ${audit} for every run`);
    }
    return {
      audit,
      statistic: 'lowest, at reference CPU',
      value: Math.min(...results.map(referenceBlockingTime)),
      limit,
    };
  });
}
