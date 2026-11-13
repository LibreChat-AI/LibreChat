import fs from 'node:fs';
import type { Browser, CDPSession, Page } from '@playwright/test';

type TraceEvent = {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: { name?: string };
};

export type FrameCost = {
  wallMs: number;
  /** Main-thread time inside top-level tasks. */
  taskMs: number;
  busyPercent: number;
  /** Frames the main thread produced (`Commit` events). */
  frames: number;
  msPerFrame: number;
  worstTaskMs: number;
  /** Tasks over 50 ms. */
  longTasks: number;
  /** Main-thread totals by timeline event, in ms. */
  byEvent: Record<string, number>;
  /** Raster time across the compositor's worker threads. */
  rasterMs: number;
};

const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  /** Call stacks on forced layout and style, so a dump names who asked. */
  'disabled-by-default-devtools.timeline.stack',
  'cc',
  'blink',
  '__metadata',
];

const MAIN_EVENTS = [
  'UpdateLayoutTree',
  'Layout',
  'PrePaint',
  'Paint',
  'Layerize',
  'Commit',
  'FunctionCall',
  'FireAnimationFrame',
  'TimerFire',
  'EventDispatch',
  'MinorGC',
  'MajorGC',
  'IntersectionObserverController::computeIntersections',
  'HitTest',
  'UpdateLayerTree',
];

/**
 * Records a Chromium trace around `during` and reduces it to what the page's
 * main thread spent, by timeline event. The busiest `CrRendererMain` thread is
 * taken as the page: the service worker and any extension renderers idle.
 */
export async function traceFrames(
  browser: Browser,
  page: Page,
  during: () => Promise<void>,
  /** Keeps the raw trace, for a closer look than the reduction gives. */
  dumpPath?: string,
): Promise<FrameCost> {
  await browser.startTracing(page, { categories: CATEGORIES });
  await during();
  const buffer = await browser.stopTracing();
  if (dumpPath) {
    fs.writeFileSync(dumpPath, buffer);
  }
  const parsed = JSON.parse(buffer.toString('utf8')) as { traceEvents: TraceEvent[] };
  const events = parsed.traceEvents;

  const mainThreads = new Set<string>();
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'CrRendererMain') {
      mainThreads.add(`${event.pid}:${event.tid}`);
    }
  }

  const taskTotals = new Map<string, number>();
  for (const event of events) {
    if (event.ph !== 'X' || event.name !== 'RunTask') {
      continue;
    }
    const key = `${event.pid}:${event.tid}`;
    if (mainThreads.has(key)) {
      taskTotals.set(key, (taskTotals.get(key) ?? 0) + (event.dur ?? 0));
    }
  }
  let mainKey = '';
  let mainTotal = -1;
  for (const [key, total] of taskTotals) {
    if (total > mainTotal) {
      mainKey = key;
      mainTotal = total;
    }
  }
  const mainPid = Number(mainKey.split(':')[0]);

  const byEvent: Record<string, number> = {};
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  let taskUs = 0;
  let worstUs = 0;
  let longTasks = 0;
  let frames = 0;
  let rasterUs = 0;
  for (const event of events) {
    if (event.ph !== 'X') {
      continue;
    }
    const duration = event.dur ?? 0;
    if (event.pid === mainPid && event.name === 'RasterTask') {
      rasterUs += duration;
    }
    if (`${event.pid}:${event.tid}` !== mainKey) {
      continue;
    }
    first = Math.min(first, event.ts);
    last = Math.max(last, event.ts + duration);
    if (event.name === 'RunTask') {
      taskUs += duration;
      worstUs = Math.max(worstUs, duration);
      if (duration > 50_000) {
        longTasks += 1;
      }
      continue;
    }
    if (event.name === 'Commit') {
      frames += 1;
    }
    if (MAIN_EVENTS.includes(event.name)) {
      byEvent[event.name] = (byEvent[event.name] ?? 0) + duration / 1000;
    }
  }
  const wallMs = Number.isFinite(first) ? (last - first) / 1000 : 0;
  const taskMs = taskUs / 1000;
  return {
    wallMs,
    taskMs,
    busyPercent: wallMs > 0 ? (taskMs / wallMs) * 100 : 0,
    frames,
    msPerFrame: frames > 0 ? taskMs / frames : 0,
    worstTaskMs: worstUs / 1000,
    longTasks,
    byEvent,
    rasterMs: rasterUs / 1000,
  };
}

export function formatFrameCost(name: string, cost: FrameCost): string {
  const parts = Object.entries(cost.byEvent)
    .filter(([, ms]) => ms >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([event, ms]) => `${event}=${ms.toFixed(0)}`)
    .join(' ');
  return (
    `${name.padEnd(34)} busy=${cost.busyPercent.toFixed(1).padStart(5)}% ` +
    `task=${cost.taskMs.toFixed(0).padStart(5)}ms/${cost.wallMs.toFixed(0)}ms ` +
    `frames=${String(cost.frames).padStart(4)} ms/frame=${cost.msPerFrame.toFixed(2).padStart(6)} ` +
    `worst=${cost.worstTaskMs.toFixed(0)}ms long=${cost.longTasks} raster=${cost.rasterMs.toFixed(0)}ms\n` +
    `    ${parts}`
  );
}

type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
};

/**
 * Samples the page's JavaScript around `during` and returns the functions with
 * the most self time, as `ms  name  file:line:column`.
 */
export async function profileScript(
  session: CDPSession,
  during: () => Promise<void>,
  limit = 30,
  dumpPath?: string,
): Promise<string[]> {
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 200 });
  await session.send('Profiler.start');
  await during();
  const { profile } = await session.send('Profiler.stop');
  if (dumpPath) {
    fs.writeFileSync(dumpPath, JSON.stringify(profile));
  }
  const nodes = new Map<number, ProfileNode>(
    (profile.nodes as ProfileNode[]).map((node) => [node.id, node]),
  );
  const self = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const node = nodes.get(samples[index]);
    if (!node) {
      continue;
    }
    const { functionName, url, lineNumber, columnNumber } = node.callFrame;
    const file = url.split('/').pop() ?? '';
    const key = `${functionName || '(anonymous)'}  ${file}:${lineNumber + 1}:${columnNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (deltas[index] ?? 0) / 1000);
  }
  return Array.from(self.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, ms]) => `${ms.toFixed(1).padStart(8)}ms  ${key}`);
}

export type WindowCost = {
  /** The mark that opened the window. */
  name: string;
  /** Main-thread time in tasks that started inside the window. */
  taskMs: number;
  worstTaskMs: number;
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
  paintMs: number;
  gcMs: number;
};

const WINDOW_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
  '__metadata',
];

const SELF_GROUPS: Record<string, keyof Omit<WindowCost, 'name' | 'taskMs' | 'worstTaskMs'>> = {
  FunctionCall: 'scriptMs',
  EvaluateScript: 'scriptMs',
  TimerFire: 'scriptMs',
  EventDispatch: 'scriptMs',
  FireAnimationFrame: 'scriptMs',
  RunMicrotasks: 'scriptMs',
  XHRReadyStateChange: 'scriptMs',
  XHRLoad: 'scriptMs',
  Layout: 'layoutMs',
  UpdateLayoutTree: 'styleMs',
  PrePaint: 'paintMs',
  Paint: 'paintMs',
  Layerize: 'paintMs',
  Commit: 'paintMs',
  MinorGC: 'gcMs',
  MajorGC: 'gcMs',
};

/**
 * Traces `during` and splits the main thread's work at each `performance.mark`
 * whose name starts with `prefix`: one window per mark, running to the next.
 * Time is self time, so a layout forced from script counts as layout.
 */
export async function traceWindows(
  browser: Browser,
  page: Page,
  prefix: string,
  during: () => Promise<void>,
): Promise<WindowCost[]> {
  await browser.startTracing(page, { categories: WINDOW_CATEGORIES });
  await during();
  const buffer = await browser.stopTracing();
  const events = (JSON.parse(buffer.toString('utf8')) as { traceEvents: TraceEvent[] }).traceEvents;

  const marks = events
    .filter((event) => event.name.startsWith(prefix) && event.ph !== 'M')
    .sort((a, b) => a.ts - b.ts);
  if (marks.length === 0) {
    return [];
  }
  /** The marks are made on the page's main thread, which names it. */
  const mainKey = `${marks[0].pid}:${marks[0].tid}`;
  const windows: WindowCost[] = marks.map((mark) => ({
    name: mark.name.slice(prefix.length),
    taskMs: 0,
    worstTaskMs: 0,
    scriptMs: 0,
    layoutMs: 0,
    styleMs: 0,
    paintMs: 0,
    gcMs: 0,
  }));
  const windowAt = (ts: number): WindowCost | null => {
    let low = 0;
    let high = marks.length - 1;
    if (ts < marks[0].ts) {
      return null;
    }
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (marks[middle].ts <= ts) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return windows[low];
  };

  const spans = events
    .filter((event) => event.ph === 'X' && `${event.pid}:${event.tid}` === mainKey)
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  /** Open ancestors, innermost last, each with the child time to subtract. */
  const stack: Array<{ event: TraceEvent; end: number; childUs: number }> = [];
  const settle = (entry: { event: TraceEvent; childUs: number }) => {
    const target = windowAt(entry.event.ts);
    const group = SELF_GROUPS[entry.event.name];
    if (target && group) {
      target[group] += ((entry.event.dur ?? 0) - entry.childUs) / 1000;
    }
  };
  for (const event of spans) {
    const duration = event.dur ?? 0;
    while (stack.length > 0 && stack[stack.length - 1].end <= event.ts) {
      settle(stack.pop()!);
    }
    if (event.name === 'RunTask') {
      const target = windowAt(event.ts);
      if (target) {
        target.taskMs += duration / 1000;
        target.worstTaskMs = Math.max(target.worstTaskMs, duration / 1000);
      }
    }
    if (stack.length > 0 && SELF_GROUPS[event.name]) {
      /** Charge the nearest grouped ancestor, so an ungrouped wrapper between
       *  two grouped events does not double count the inner one. */
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (SELF_GROUPS[stack[depth].event.name]) {
          stack[depth].childUs += duration;
          break;
        }
      }
    }
    stack.push({ event, end: event.ts + duration, childUs: 0 });
  }
  while (stack.length > 0) {
    settle(stack.pop()!);
  }
  return windows;
}
