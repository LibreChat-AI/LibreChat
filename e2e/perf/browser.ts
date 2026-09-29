import type { CDPSession, Page, TestInfo } from '@playwright/test';

const METRIC_NAMES = [
  'Timestamp',
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'LayoutCount',
  'RecalcStyleCount',
  'JSHeapUsedSize',
  'Nodes',
] as const;

type MetricName = (typeof METRIC_NAMES)[number];
type MetricMap = Record<MetricName, number>;

export interface BrowserPhase {
  elapsedMs: number;
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
  busyPercent: number;
  layoutCount: number;
  styleCount: number;
  heapDeltaBytes: number;
  heapEndBytes: number;
  nodesEnd: number;
  longTasks: number[];
}

interface BrowserPerfGlobal {
  longTasks: number[];
  reset(): void;
  drain(): void;
}

declare global {
  interface Window {
    __BROWSER_PERF__: BrowserPerfGlobal;
  }
}

const LONG_TASK_OBSERVER = `(() => {
  const perf = {
    longTasks: [],
    observer: null,
    drain() {
      if (!this.observer) {
        return;
      }
      for (const entry of this.observer.takeRecords()) {
        this.longTasks.push(entry.duration);
      }
    },
    reset() {
      this.drain();
      this.longTasks = [];
    },
  };
  window.__BROWSER_PERF__ = perf;
  try {
    perf.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        perf.longTasks.push(entry.duration);
      }
    });
    perf.observer.observe({ type: 'longtask', buffered: true });
  } catch (_error) {
    /* longtask unsupported: totals stay empty */
  }
})();`;

async function readMetrics(session: CDPSession): Promise<MetricMap> {
  const response = await session.send('Performance.getMetrics');
  const values = new Map(response.metrics.map(({ name, value }) => [name, value]));
  return Object.fromEntries(METRIC_NAMES.map((name) => [name, values.get(name) ?? 0])) as MetricMap;
}

export async function installBrowserPerf(page: Page): Promise<void> {
  await page.addInitScript({ content: LONG_TASK_OBSERVER });
}

export async function createBrowserProbe(page: Page): Promise<{
  start(): Promise<void>;
  finish(): Promise<BrowserPhase>;
}> {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  let startMetrics: MetricMap | null = null;

  return {
    async start() {
      await page.evaluate(() => window.__BROWSER_PERF__.reset());
      startMetrics = await readMetrics(session);
    },
    async finish() {
      if (!startMetrics) {
        throw new Error('Browser performance probe must be started before it is finished');
      }
      const endMetrics = await readMetrics(session);
      const longTasks = await page.evaluate(() => {
        window.__BROWSER_PERF__.drain();
        return window.__BROWSER_PERF__.longTasks.slice();
      });
      const secondsToMs = (name: MetricName) =>
        (endMetrics[name] - (startMetrics?.[name] ?? 0)) * 1000;
      const elapsedMs = secondsToMs('Timestamp');
      const taskMs = secondsToMs('TaskDuration');
      return {
        elapsedMs,
        taskMs,
        scriptMs: secondsToMs('ScriptDuration'),
        layoutMs: secondsToMs('LayoutDuration'),
        styleMs: secondsToMs('RecalcStyleDuration'),
        busyPercent: elapsedMs > 0 ? (taskMs / elapsedMs) * 100 : 0,
        layoutCount: endMetrics.LayoutCount - startMetrics.LayoutCount,
        styleCount: endMetrics.RecalcStyleCount - startMetrics.RecalcStyleCount,
        heapDeltaBytes: endMetrics.JSHeapUsedSize - startMetrics.JSHeapUsedSize,
        heapEndBytes: endMetrics.JSHeapUsedSize,
        nodesEnd: endMetrics.Nodes,
        longTasks,
      };
    },
  };
}

export function formatBrowserPhase(name: string, phase: BrowserPhase): string {
  const longTaskTotal = phase.longTasks.reduce((sum, duration) => sum + duration, 0);
  const worstLongTask = phase.longTasks.reduce((max, duration) => Math.max(max, duration), 0);
  return (
    `${name.padEnd(18)} wall=${phase.elapsedMs.toFixed(0).padStart(6)}ms ` +
    `busy=${phase.busyPercent.toFixed(1).padStart(5)}% ` +
    `task=${phase.taskMs.toFixed(0).padStart(6)}ms ` +
    `script=${phase.scriptMs.toFixed(0).padStart(6)}ms ` +
    `layout=${phase.layoutMs.toFixed(0).padStart(5)}ms ` +
    `style=${phase.styleMs.toFixed(0).padStart(5)}ms ` +
    `longtasks=${longTaskTotal.toFixed(0)}/${worstLongTask.toFixed(0)}ms ` +
    `heap=${(phase.heapEndBytes / 1024 / 1024).toFixed(1)}MB nodes=${phase.nodesEnd}`
  );
}

export async function attachBrowserPhases(
  testInfo: TestInfo,
  name: string,
  phases: Record<string, BrowserPhase>,
): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(phases, null, 2),
    contentType: 'application/json',
  });
}
