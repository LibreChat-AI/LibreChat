import fs from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Shared react-scan instrumentation for the render-perf benchmarks.
 *
 * react-scan is injected from disk rather than depended on, so the repo does
 * not carry it; point `REACT_SCAN_PATH` at `react-scan/dist/auto.global.js`.
 * Baselines are version-sensitive (instrumentation overhead and `onRender`
 * semantics both move between releases), so keep the version pinned to the one
 * each benchmark's README records.
 */

export type RenderTally = Record<string, { count: number; time: number }>;

export type PerfSnapshot = {
  renders: RenderTally;
  longTasks: number[];
  /** Milliseconds between the phase's anchor render and this snapshot, on the
   *  page's own clock: the first `anchorComponent` render when one occurred,
   *  else the first render after the reset, else the reset itself. Idle setup
   *  time before anything renders never pads the interval. */
  elapsedMs: number;
};

type PerfGlobal = {
  renders: RenderTally;
  longTasks: number[];
  startedAt: number;
  firstRenderAt: number | null;
  firstAnchorRenderAt: number | null;
  drain(): void;
  reset(): void;
};

declare global {
  interface Window {
    __PERF__: PerfGlobal;
  }
}

export function resolveReactScanPath(): string {
  const fromEnv = process.env.REACT_SCAN_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  return require.resolve('react-scan/dist/auto.global.js');
}

/**
 * Builds the page-side tally script. `anchorComponent` names the component
 * whose first render starts the measured interval; omit it to anchor on the
 * first render of any component.
 */
export function buildTallySetup(anchorComponent?: string): string {
  const anchor = JSON.stringify(anchorComponent ?? null);
  return `(() => {
  const ANCHOR = ${anchor};
  const perf = {
    renders: Object.create(null),
    longTasks: [],
    observer: null,
    startedAt: performance.now(),
    firstRenderAt: null,
    firstAnchorRenderAt: null,
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
      this.renders = Object.create(null);
      this.longTasks = [];
      this.startedAt = performance.now();
      this.firstRenderAt = null;
      this.firstAnchorRenderAt = null;
    },
  };
  window.__PERF__ = perf;
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
  const nameOf = (fiber) => {
    let type = fiber && fiber.type;
    for (let depth = 0; depth < 4 && type; depth += 1) {
      if (typeof type === 'function') {
        return type.displayName || type.name || null;
      }
      if (typeof type === 'object') {
        if (type.displayName) {
          return type.displayName;
        }
        type = type.type || type.render;
        continue;
      }
      return String(type);
    }
    return null;
  };
  const configure = () => {
    if (typeof window.reactScan !== 'function') {
      return false;
    }
    window.reactScan({
      enabled: true,
      log: false,
      showToolbar: false,
      animationSpeed: 'off',
      trackUnnecessaryRenders: false,
      dangerouslyForceRunInProduction: true,
      onRender: (fiber, renders) => {
        if (perf.firstRenderAt == null) {
          perf.firstRenderAt = performance.now();
        }
        for (const render of renders) {
          const name = render.componentName || nameOf(fiber) || 'anonymous';
          if (ANCHOR != null && perf.firstAnchorRenderAt == null && name === ANCHOR) {
            perf.firstAnchorRenderAt = performance.now();
          }
          let slot = perf.renders[name];
          if (!slot) {
            slot = { count: 0, time: 0 };
            perf.renders[name] = slot;
          }
          slot.count += render.count || 1;
          slot.time += render.time || 0;
        }
      },
    });
    return true;
  };
  if (!configure()) {
    const timer = setInterval(() => {
      if (configure()) {
        clearInterval(timer);
      }
    }, 50);
  }
})();`;
}

/** Injects react-scan plus the tally script before any app code runs. */
export async function installReactScan(page: Page, anchorComponent?: string): Promise<void> {
  await page.addInitScript({ content: fs.readFileSync(resolveReactScanPath(), 'utf8') });
  await page.addInitScript({ content: buildTallySetup(anchorComponent) });
}

export async function snapshotPerf(page: Page): Promise<PerfSnapshot> {
  return page.evaluate(() => {
    window.__PERF__.drain();
    return {
      renders: window.__PERF__.renders,
      longTasks: window.__PERF__.longTasks.slice(),
      elapsedMs:
        performance.now() -
        (window.__PERF__.firstAnchorRenderAt ??
          window.__PERF__.firstRenderAt ??
          window.__PERF__.startedAt),
    };
  });
}

export async function resetPerf(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__PERF__.reset();
  });
}

export function totals(snapshot: PerfSnapshot): { renders: number; time: number } {
  let renders = 0;
  let time = 0;
  for (const slot of Object.values(snapshot.renders)) {
    renders += slot.count;
    time += slot.time;
  }
  return { renders, time };
}

export function topComponents(snapshot: PerfSnapshot, limit: number): string[] {
  return Object.entries(snapshot.renders)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(
      ([name, slot]) =>
        `${name.padEnd(28)} renders=${String(slot.count).padStart(6)} time=${slot.time.toFixed(1)}ms`,
    );
}

export function longTaskStats(snapshot: PerfSnapshot): { total: number; worst: number } {
  let total = 0;
  let worst = 0;
  for (const duration of snapshot.longTasks) {
    total += duration;
    worst = Math.max(worst, duration);
  }
  return { total, worst };
}

export async function attachSnapshot(
  testInfo: TestInfo,
  name: string,
  snapshot: PerfSnapshot,
  extra: Record<string, number>,
): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify({ ...extra, ...snapshot }, null, 2),
    contentType: 'application/json',
  });
}
