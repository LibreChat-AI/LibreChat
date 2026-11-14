import fs from 'node:fs';
import path from 'node:path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import type { CDPSession, Page } from '@playwright/test';

/**
 * Which components rendered, how often, and what made each one render: a prop
 * that changed identity, one of its own state or store hooks, a context it
 * reads, or nothing of its own (its parent rendered and it is not memoized).
 *
 * Works on the production bundle. React reports each commit to the DevTools
 * hook whether or not DevTools is there, so a stand-in installed before the
 * bundle loads sees every fiber that did work. Minified component names mean
 * nothing, so each component is named by where its function is defined, which
 * the browser knows, and by the source map when the build wrote one.
 */

type ProbeRow = { index: number; renders: number; reasons: Record<string, number> };

declare global {
  interface Window {
    __FADE_WHY__?: {
      enabled: boolean;
      functions: unknown[];
      commits: number;
      report(): ProbeRow[];
      reset(): void;
    };
  }
}

const PROBE = `(() => {
  const rows = new Map();
  const probe = {
    enabled: false,
    functions: [],
    commits: 0,
    reset() { rows.clear(); probe.functions.length = 0; probe.commits = 0; },
    report() {
      return Array.from(rows.values()).map((row) => ({
        index: row.index, renders: row.renders, reasons: Object.fromEntries(row.reasons),
      }));
    },
  };
  const functionOf = (type) => {
    if (typeof type === 'function') return type;
    if (type && typeof type === 'object') return functionOf(type.render ?? type.type);
    return null;
  };
  const describe = (value) => {
    if (value === null || typeof value !== 'object') return typeof value;
    if (Array.isArray(value)) return 'array[' + value.length + ']';
    return '{' + Object.keys(value).slice(0, 6).join(',') + '}';
  };
  const reasonsFor = (fiber) => {
    const before = fiber.alternate;
    if (!before) return ['mount'];
    const reasons = [];
    const was = before.memoizedProps ?? {};
    const now = fiber.memoizedProps ?? {};
    if (was !== now) {
      const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
      for (const key of keys) {
        if (!Object.is(was[key], now[key])) reasons.push('prop ' + key);
      }
    }
    let hook = fiber.memoizedState;
    let old = before.memoizedState;
    let position = 0;
    while (hook && old) {
      if (hook.queue != null && !Object.is(hook.memoizedState, old.memoizedState)) {
        const value = hook.memoizedState;
        const prior = old.memoizedState;
        /** A query result is a new object on every cache write, whatever its
         *  reader selected. Only its data says whether the reader had to render. */
        const isQuery = value && typeof value === 'object' && 'fetchStatus' in value;
        if (!isQuery) {
          reasons.push('state #' + position + ' ' + describe(value));
        } else if (!Object.is(value.data, prior?.data)) {
          reasons.push('query #' + position + ' ' + describe(value.data));
        }
      }
      hook = hook.next; old = old.next; position += 1;
    }
    let read = fiber.dependencies?.firstContext;
    let readBefore = before.dependencies?.firstContext;
    let slot = 0;
    while (read && readBefore) {
      if (!Object.is(read.memoizedValue, readBefore.memoizedValue)) {
        reasons.push('context #' + slot + ' ' + describe(read.memoizedValue));
      }
      read = read.next; readBefore = readBefore.next; slot += 1;
    }
    return reasons.length > 0 ? reasons : ['parent'];
  };
  const visit = (fiber) => {
    for (let node = fiber; node; node = node.sibling) {
      const fn = functionOf(node.type);
      const worked = (node.flags & 1) !== 0 || node.alternate == null;
      if (fn && worked) {
        let row = rows.get(fn);
        if (!row) {
          row = { index: probe.functions.push(fn) - 1, renders: 0, reasons: new Map() };
          rows.set(fn, row);
        }
        row.renders += 1;
        for (const reason of reasonsFor(node)) {
          row.reasons.set(reason, (row.reasons.get(reason) ?? 0) + 1);
        }
      }
      /** A subtree React did not touch keeps the child it had. */
      if (node.child && node.child !== node.alternate?.child) visit(node.child);
    }
  };
  window.__FADE_WHY__ = probe;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject(renderer) { this.renderers.set(this.renderers.size + 1, renderer); return this.renderers.size; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!probe.enabled) return;
      probe.commits += 1;
      try { visit(root.current); } catch (_error) { /* a probe must never break the page */ }
    },
  };
})();`;

export type RenderProbe = {
  start(): Promise<void>;
  /** Stops counting and returns one line per component, most renders first. */
  finish(limit?: number): Promise<{ commits: number; lines: string[] }>;
};

/**
 * Installs the probe ahead of the bundle. Call before the page navigates; the
 * debugger is enabled only to learn which script each function came from.
 */
export async function installRenderProbe(page: Page): Promise<RenderProbe> {
  await page.addInitScript({ content: PROBE });
  const session: CDPSession = await page.context().newCDPSession(page);
  const scripts = new Map<string, string>();
  session.on('Debugger.scriptParsed', (event) => {
    if (event.url) {
      scripts.set(event.scriptId, event.url);
    }
  });
  await session.send('Debugger.enable');

  const maps = new Map<string, TraceMap | null>();
  const mapAt = (file: string): TraceMap | null => {
    if (!maps.has(file)) {
      maps.set(file, fs.existsSync(file) ? new TraceMap(fs.readFileSync(file, 'utf8')) : null);
    }
    return maps.get(file) ?? null;
  };
  const root = path.resolve(__dirname, '../..');
  const nameAt = (url: string, line: number, column: number): string => {
    const file = url.split('/').pop() ?? '';
    const fallback = `${file}:${line + 1}:${column + 1}`;
    const bundle = mapAt(path.join(root, 'client/dist/assets', `${file}.map`));
    let position = bundle ? originalPositionFor(bundle, { line: line + 1, column }) : null;
    if (!position?.source) {
      return fallback;
    }
    let source = position.source;
    /** The workspace packages are bundled from their own builds, each with its own map. */
    const built = source.match(/packages\/(chat|client|data-provider)\/dist\/(.+)$/);
    const inner = built
      ? mapAt(path.join(root, 'packages', built[1], 'dist', `${built[2]}.map`))
      : null;
    const deeper = inner
      ? originalPositionFor(inner, { line: position.line ?? 1, column: position.column ?? 0 })
      : null;
    if (built && deeper?.source) {
      position = { ...deeper, name: deeper.name ?? position.name };
      source = `packages/${built[1]}/${deeper.source.replace(/^(\.\.\/)+/, '')}`;
    }
    return `${position.name ?? '(anonymous)'} ${source.replace(/^(\.\.\/)+/, '')}:${position.line}`;
  };

  return {
    async start() {
      await page.evaluate(() => {
        window.__FADE_WHY__?.reset();
        if (window.__FADE_WHY__) {
          window.__FADE_WHY__.enabled = true;
        }
      });
    },
    async finish(limit = 60) {
      const { rows, commits } = await page.evaluate(() => {
        const probe = window.__FADE_WHY__;
        if (probe) {
          probe.enabled = false;
        }
        return { rows: probe?.report() ?? [], commits: probe?.commits ?? 0 };
      });
      rows.sort((a, b) => b.renders - a.renders);
      const lines: string[] = [];
      for (const row of rows.slice(0, limit)) {
        const { result } = await session.send('Runtime.evaluate', {
          expression: `window.__FADE_WHY__.functions[${row.index}]`,
        });
        let name = '(unknown)';
        if (result.objectId) {
          const { internalProperties } = await session.send('Runtime.getProperties', {
            objectId: result.objectId,
            ownProperties: true,
          });
          const location = internalProperties?.find(
            (entry) => entry.name === '[[FunctionLocation]]',
          )?.value?.value as
            | { scriptId: string; lineNumber: number; columnNumber: number }
            | undefined;
          if (location) {
            name = nameAt(
              scripts.get(location.scriptId) ?? '',
              location.lineNumber,
              location.columnNumber,
            );
          }
        }
        const reasons = Object.entries(row.reasons)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([reason, count]) => `${reason} ×${count}`)
          .join('; ');
        lines.push(`${String(row.renders).padStart(6)}  ${name}\n          ${reasons}`);
      }
      return { commits, lines };
    },
  };
}
