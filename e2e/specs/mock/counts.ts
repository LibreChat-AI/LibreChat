import type { Page } from '@playwright/test';

/**
 * Counts of the work a page does, read from the built client. A count does not depend on how
 * fast the machine is, so it can be held to a budget where a duration cannot.
 */

type Probe = {
  counting: boolean;
  /** Component renders in each commit since counting began. */
  commits: number[];
  /** Of those, the renders outside every message row. */
  around: number[];
  /** Renders inside each message row, over all of the commits. */
  rows: Map<Element, number>;
  outside: number;
  /** Rows in the document at each frame in which their number changed. */
  mounted: number[];
};

declare global {
  interface Window {
    __COUNTS__?: Probe;
  }
}

/**
 * React reports every commit to the DevTools hook whether or not DevTools is installed, so a
 * stand-in set before the bundle loads sees each component that rendered. A row's renders are
 * the ones below its element; the memoized wrappers above it are counted with the page's.
 */
const PROBE = `(() => {
  const probe = { counting: false, commits: [], around: [], rows: new Map(), outside: 0, mounted: [] };
  const isComponent = (type) =>
    typeof type === 'function' ||
    (type != null && typeof type === 'object' && isComponent(type.render ?? type.type));
  const visit = (fiber, row) => {
    let renders = 0;
    for (let node = fiber; node; node = node.sibling) {
      let inside = row;
      if (node.tag === 5 && node.stateNode?.classList?.contains('message-render')) {
        inside = node.stateNode;
      }
      if (isComponent(node.type) && ((node.flags & 1) !== 0 || node.alternate == null)) {
        renders += 1;
        if (inside) probe.rows.set(inside, (probe.rows.get(inside) ?? 0) + 1);
        else probe.outside += 1;
      }
      /** A subtree React did not touch keeps the child it had. */
      if (node.child && node.child !== node.alternate?.child) renders += visit(node.child, inside);
    }
    return renders;
  };
  window.__COUNTS__ = probe;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject(renderer) { this.renderers.set(this.renderers.size + 1, renderer); return this.renderers.size; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      if (!probe.counting) return;
      probe.outside = 0;
      try {
        probe.commits.push(visit(root.current, null));
        probe.around.push(probe.outside);
      } catch (_error) { /* a probe must never break the page */ }
    },
  };
  const rows = document.getElementsByClassName('message-render');
  const sample = () => {
    if (probe.mounted[probe.mounted.length - 1] !== rows.length) probe.mounted.push(rows.length);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})();`;

/** Installs the probe ahead of the bundle: call before the page navigates. */
export async function installCounts(page: Page): Promise<void> {
  await page.addInitScript({ content: PROBE });
}

/** Rows added in each frame since the page loaded: a thread mounted in one commit is one step. */
export async function mountSteps(page: Page): Promise<number[]> {
  const mounted = await page.evaluate(() => window.__COUNTS__?.mounted ?? []);
  return mounted.slice(1).map((count, index) => count - mounted[index]);
}

export type Renders = {
  commits: number;
  /**
   * Component renders in one streamed frame: the count more commits share than any other. A
   * reply is a few hundred commits and most of them write one frame of its text, where a mean
   * or a median moves with how the frames happened to batch.
   */
  frame: number;
  /** Of a frame's renders, those outside every row: the thread, the composer, the page. */
  around: number;
  /** Renders inside the rows that were in the thread when counting began, over every commit. */
  earlier: number;
};

/** Counts renders from here to the returned call, which stops the count and reads it. */
export async function countRenders(page: Page): Promise<() => Promise<Renders>> {
  await page.evaluate(() => {
    const probe = window.__COUNTS__;
    if (!probe) {
      throw new Error('installCounts was not called before the page loaded');
    }
    probe.commits = [];
    probe.around = [];
    probe.rows = new Map();
    probe.counting = true;
    for (const row of Array.from(document.getElementsByClassName('message-render'))) {
      row.setAttribute('data-counted-earlier', '');
    }
  });
  return () =>
    page.evaluate(() => {
      const probe = window.__COUNTS__ as Probe;
      probe.counting = false;
      let earlier = 0;
      for (const [row, renders] of probe.rows) {
        if (row.hasAttribute('data-counted-earlier')) {
          earlier += renders;
        }
      }
      /** The pair, not the total alone: an unrelated commit can render as many components. */
      const shared = new Map<string, number>();
      let frame = 0;
      let around = 0;
      let most = 0;
      probe.commits.forEach((renders, commit) => {
        const key = `${renders}:${probe.around[commit]}`;
        const commits = (shared.get(key) ?? 0) + 1;
        shared.set(key, commits);
        if (commits > most) {
          most = commits;
          frame = renders;
          around = probe.around[commit];
        }
      });
      return { commits: probe.commits.length, frame, around, earlier };
    });
}

/**
 * Every element of the thread: its scroller and all that is inside. The rest of the page is left
 * out, since what the sidebar holds depends on what the tests before this one left behind.
 */
export const countElements = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
    if (!scroller) {
      throw new Error('thread not mounted');
    }
    return scroller.getElementsByTagName('*').length;
  });

/**
 * Event listeners attached to `document` and `window`, by event type: a listener per row there
 * runs on every such event, wherever the pointer or the focus is.
 */
export async function countListeners(page: Page): Promise<Record<string, number>> {
  const session = await page.context().newCDPSession(page);
  const counts: Record<string, number> = {};
  for (const expression of ['document', 'window']) {
    const { result } = await session.send('Runtime.evaluate', { expression });
    if (result.objectId == null) {
      continue;
    }
    const { listeners } = await session.send('DOMDebugger.getEventListeners', {
      objectId: result.objectId,
    });
    for (const listener of listeners) {
      /** The test runner's own listeners come and go with how a run is traced. */
      if (!listener.type.startsWith('__playwright')) {
        counts[listener.type] = (counts[listener.type] ?? 0) + 1;
      }
    }
  }
  await session.detach();
  return counts;
}

/** Waits until `read` returns the same number three times in a row, and returns it. */
export async function settled(page: Page, read: () => Promise<number>): Promise<number> {
  let last = await read();
  let same = 0;
  while (same < 2) {
    await page.waitForTimeout(250);
    const next = await read();
    same = next === last ? same + 1 : 0;
    last = next;
  }
  return last;
}

/**
 * Scrolls the thread from its end to its start a screen at a time, the way a reader goes back
 * through it, so every row has been near the viewport once.
 */
export async function readThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
    if (!scroller) {
      throw new Error('thread not mounted');
    }
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    while (scroller.scrollTop > 0) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.8);
      await frame();
      await frame();
    }
  });
}
