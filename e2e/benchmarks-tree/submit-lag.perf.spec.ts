import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../specs/mock/db';
import { MOCK_ENDPOINTS, messagesView } from '../specs/mock/helpers';
import { buildTreeMessages, TURNS, turnHeading } from './payload';
import { getE2EUser } from '../setup/user';

/**
 * Submit-lag benchmark: what the page does between the Enter press on a long
 * thread and the new turn painting, and while the reply streams in.
 *
 * Dev build (component names, per-commit render reasons):
 *   npx playwright test -c e2e/playwright.config.tree-perf.ts submit-lag
 * Built client (production timings; names are minified):
 *   npx playwright test -c e2e/playwright.config.tree-perf-prod.ts submit-lag
 *
 * `TREE_PERF_TURNS` sizes the synthetic thread. `SUBMIT_LAG_SOURCE=<export.json>`
 * seeds a real exported conversation (`{ messages }`) instead, re-owned by the e2e
 * user and pointed at the mock endpoint. `SUBMIT_LAG_FLAT=false` measures the
 * recursive renderer. The numbers are printed; nothing is asserted.
 */

const userEmail = getE2EUser().email;
const ENDPOINT = MOCK_ENDPOINTS[0];
const SOURCE = process.env.SUBMIT_LAG_SOURCE;
const FLAT = process.env.SUBMIT_LAG_FLAT !== 'false';
const CONVO = { id: randomUUID(), title: 'Submit lag bench' };
const PROFILE_MS = Number(process.env.SUBMIT_LAG_PROFILE_MS) || 1500;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

type RawMessage = Record<string, unknown> & { messageId: string; parentMessageId: string };

/** Storage bookkeeping an exported document carries that the seed must not copy. */
const STORAGE_KEYS = new Set(['_id', '_meiliIndex', '_meiliCleanupVersion', 'expiredAt']);

function sourceMessages(): { messages: RawMessage[]; lastText: string } {
  if (!SOURCE) {
    const messages = buildTreeMessages('L') as unknown as RawMessage[];
    return { messages, lastText: turnHeading('L', TURNS) };
  }
  const exported = JSON.parse(fs.readFileSync(SOURCE, 'utf8')) as { messages: RawMessage[] };
  return { messages: exported.messages, lastText: '' };
}

async function seed(): Promise<{ count: number; lastText: string }> {
  const { messages, lastText } = sourceMessages();
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) {
      throw new Error(`seed: user "${userEmail}" not found`);
    }
    const userId = user._id.toString();
    const now = new Date();
    await db.collection('conversations').insertOne({
      conversationId: CONVO.id,
      title: CONVO.title,
      user: userId,
      endpoint: ENDPOINT.label,
      endpointType: 'custom',
      model: ENDPOINT.model,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
      __v: 0,
    });
    const start = Date.now() - messages.length * 2000;
    const docs = messages.map((message, index) => {
      const fields = Object.entries(message).filter(([key]) => !STORAGE_KEYS.has(key));
      return {
        ...Object.fromEntries(fields),
        conversationId: CONVO.id,
        user: userId,
        endpoint: ENDPOINT.label,
        model: ENDPOINT.model,
        error: false,
        unfinished: false,
        createdAt: new Date(start + index * 1000),
        updatedAt: new Date(start + index * 1000),
        __v: 0,
      };
    });
    await db.collection('messages').insertMany(docs);
  });
  return { count: messages.length, lastText };
}

/**
 * Page-side probe. A devtools-hook stub counts, per commit, which function
 * components actually rendered (DevTools' own `PerformedWork` + child-pointer
 * rule) and their self render time; the walk only runs while `tally` is on so
 * the timing pass carries no instrumentation cost.
 */
const PROBE = `(() => {
  const lag = {
    tally: false,
    t0: null,
    marker: null,
    userRowAt: null,
    commits: [],
    longTasks: [],
    events: [],
    reset(marker) {
      this.t0 = null;
      this.marker = marker;
      this.userRowAt = null;
      this.commits = [];
      this.longTasks = [];
      this.events = [];
    },
  };
  window.__LAG__ = lag;
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && lag.marker && lag.t0 == null) {
      lag.t0 = performance.now();
    }
  }, true);
  new MutationObserver((records) => {
    if (!lag.marker || lag.userRowAt != null || lag.t0 == null) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && !node.closest('form') && (node.textContent || '').includes(lag.marker)) {
          lag.userRowAt = performance.now();
          return;
        }
      }
    }
  }).observe(document, { childList: true, subtree: true });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) lag.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        lag.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration,
          processing: entry.processingEnd - entry.processingStart, delay: entry.processingStart - entry.startTime });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch (_) {}
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const nameOf = (fiber) => {
    let type = fiber.type;
    for (let depth = 0; depth < 4 && type; depth += 1) {
      if (typeof type === 'function') return type.displayName || type.name || 'anonymous';
      if (typeof type === 'object') {
        if (type.displayName) return type.displayName;
        type = type.type || type.render;
        continue;
      }
      return String(type);
    }
    return 'anonymous';
  };
  const record = (stats, fiber, mounted) => {
    const name = nameOf(fiber);
    let slot = stats[name];
    if (!slot) { slot = { renders: 0, mounts: 0, time: 0 }; stats[name] = slot; }
    if (mounted) slot.mounts += 1; else slot.renders += 1;
    slot.time += fiber.selfBaseDuration || 0;
  };
  const WATCH = new Set(['MessageContent', 'ContentRender', 'HoverButtons', 'MessageRow', 'Fork',
    'MessageTimestamp', 'ChatView', 'ChatForm', 'MessagesViewContent', 'List', 'Row', 'Message',
    'MessageRender', 'ContentParts', 'SiblingSwitch', 'SidebarChatProvider', 'MessageNav']);
  const isPlain = (value) => value != null && typeof value === 'object' && !Array.isArray(value) && !value.$$typeof;
  const reasonsOf = (fiber) => {
    const prev = fiber.alternate;
    const reasons = [];
    const a = prev.memoizedProps || {};
    const b = fiber.memoizedProps || {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key === 'children' || a[key] === b[key]) continue;
      if (isPlain(a[key]) && isPlain(b[key])) {
        const inner = [];
        for (const sub of new Set([...Object.keys(a[key]), ...Object.keys(b[key])])) {
          let av; let bv;
          try { av = a[key][sub]; bv = b[key][sub]; } catch (_) { continue; }
          if (av !== bv) inner.push(sub);
        }
        reasons.push('prop:' + key + (inner.length ? '{' + inner.slice(0, 6).join(',') + '}' : '{same-fields}'));
      } else {
        reasons.push('prop:' + key);
      }
    }
    let dep = fiber.dependencies && fiber.dependencies.firstContext;
    let prevDep = prev.dependencies && prev.dependencies.firstContext;
    while (dep) {
      if (!prevDep || dep.memoizedValue !== prevDep.memoizedValue) {
        const ctx = dep.context;
        const name = ctx.displayName || (ctx.Provider && ctx.Provider.displayName) || 'Context';
        let inner = '';
        if (prevDep && isPlain(dep.memoizedValue) && isPlain(prevDep.memoizedValue)) {
          const changed = [];
          for (const sub of Object.keys(dep.memoizedValue)) {
            if (dep.memoizedValue[sub] !== prevDep.memoizedValue[sub]) changed.push(sub);
          }
          inner = '{' + changed.slice(0, 8).join(',') + '}';
        }
        reasons.push('ctx:' + name + inner);
      }
      dep = dep.next;
      prevDep = prevDep && prevDep.next;
    }
    let hook = fiber.memoizedState;
    let prevHook = prev.memoizedState;
    let index = 0;
    while (hook && prevHook && fiber.tag !== 1) {
      if (hook.queue && hook.memoizedState !== prevHook.memoizedState) {
        const repr = (value) => {
          if (Array.isArray(value)) return 'arr' + value.length + (value.length ? ':' + repr(value[0]) : '');
          if (value && typeof value === 'object') return 'obj{' + Object.keys(value).slice(0, 3).join(',') + '}';
          return String(value).slice(0, 24);
        };
        reasons.push('state#' + index + '(' + repr(prevHook.memoizedState) + '>' + repr(hook.memoizedState) + ')');
      }
      hook = hook.next; prevHook = prevHook.next; index += 1;
    }
    if (!reasons.length) reasons.push('parent');
    return reasons;
  };
  const walk = (rootFiber) => {
    const stats = Object.create(null);
    const why = Object.create(null);
    const stack = [[rootFiber, false]];
    while (stack.length) {
      const [fiber, mounting] = stack.pop();
      const prev = fiber.alternate;
      const mounted = mounting || prev == null;
      if (COMPONENT_TAGS.has(fiber.tag) && (mounted || (fiber.flags & 1) === 1)) {
        record(stats, fiber, mounted);
        const name = nameOf(fiber);
        if (!mounted && WATCH.has(name)) {
          const bucket = (why[name] ??= Object.create(null));
          for (const reason of reasonsOf(fiber)) bucket[reason] = (bucket[reason] || 0) + 1;
        }
      }
      if (mounted || fiber.child !== prev.child) {
        for (let child = fiber.child; child; child = child.sibling) stack.push([child, mounted]);
      }
    }
    return { stats, why };
  };
  let nextId = 1;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject(renderer) { const id = nextId++; this.renderers.set(id, renderer); return id; },
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    onCommitFiberRoot(_id, root) {
      if (!lag.tally || lag.t0 == null) return;
      const at = performance.now();
      const { stats, why } = walk(root.current);
      lag.commits.push({ at, walkMs: performance.now() - at, actual: root.current.actualDuration || 0, stats, why });
    },
  };
})();`;

type Slot = { renders: number; mounts: number; time: number };
type Commit = {
  at: number;
  walkMs: number;
  actual: number;
  stats: Record<string, Slot>;
  why: Record<string, Record<string, number>>;
};
type Probe = {
  t0: number | null;
  userRowAt: number | null;
  commits: Commit[];
  longTasks: Array<{ start: number; duration: number }>;
  events: Array<{
    name: string;
    start: number;
    duration: number;
    processing: number;
    delay: number;
  }>;
};

declare global {
  interface Window {
    __LAG__: Probe & { tally: boolean; reset(marker: string): void };
  }
}

type ProfileNode = {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
};

/** Self and inclusive CPU time per function from a CDP profile. */
function summarizeProfile(profile: {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
}) {
  const parent = new Map<number, number>();
  const byId = new Map<number, ProfileNode>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) {
      parent.set(child, node.id);
    }
  }
  const keyOf = (node: ProfileNode) => {
    const file = node.callFrame.url.split('/').pop()?.split('?')[0] ?? '';
    return `${node.callFrame.functionName || '(anon)'} ${file}:${node.callFrame.lineNumber + 1}`;
  };
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    const leaf = byId.get(profile.samples[i]);
    if (!leaf) {
      continue;
    }
    self.set(keyOf(leaf), (self.get(keyOf(leaf)) ?? 0) + dt);
    const seen = new Set<string>();
    for (let id: number | undefined = leaf.id; id != null; id = parent.get(id)) {
      const node = byId.get(id);
      if (!node) break;
      const key = keyOf(node);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + dt);
    }
  }
  const top = (map: Map<string, number>, n: number) =>
    [...map.entries()]
      .filter(([key]) => !/^\((program|idle|root|garbage collector)\)/.test(key))
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  return { self: top(self, 30), inclusive: top(inclusive, 60) };
}

async function submit(page: Page, marker: string, beforeEnter?: () => Promise<void>) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  await input.fill(`E2E_SLOW_REPLY:${marker}`);
  await page.evaluate((m) => window.__LAG__.reset(m), marker);
  await page.waitForTimeout(300);
  await beforeEnter?.();
  await input.press('Enter');
}

async function waitForTurnEnd(page: Page) {
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
    timeout: 120_000,
  });
  await page.waitForTimeout(1500);
}

function reportTimeline(label: string, probe: Probe) {
  const t0 = probe.t0 ?? 0;
  console.log(`\n=== ${label} ===`);
  console.log(
    `enter -> user row in DOM: ${probe.userRowAt ? (probe.userRowAt - t0).toFixed(0) : 'n/a'}ms`,
  );
  const events = probe.events.filter((e) => e.start >= t0 - 50);
  for (const e of events.slice(0, 8)) {
    console.log(
      `  event ${e.name.padEnd(10)} +${(e.start - t0).toFixed(0)}ms duration=${e.duration.toFixed(0)} delay=${e.delay.toFixed(0)} processing=${e.processing.toFixed(0)}`,
    );
  }
  const tasks = probe.longTasks.filter((task) => task.start >= t0 - 50);
  const total = tasks.reduce((sum, task) => sum + task.duration, 0);
  console.log(`long tasks after enter: n=${tasks.length} total=${total.toFixed(0)}ms`);
  for (const task of tasks.slice(0, 40)) {
    console.log(`  +${(task.start - t0).toFixed(0).padStart(6)}ms  ${task.duration.toFixed(0)}ms`);
  }
}

function reportCommits(label: string, probe: Probe, limit: number) {
  const t0 = probe.t0 ?? 0;
  console.log(`\n=== ${label}: ${probe.commits.length} commits ===`);
  const totals: Record<string, Slot> = Object.create(null);
  for (const [index, commit] of probe.commits.entries()) {
    let renders = 0;
    let mounts = 0;
    let time = 0;
    for (const [name, slot] of Object.entries(commit.stats)) {
      renders += slot.renders;
      mounts += slot.mounts;
      time += slot.time;
      const total = (totals[name] ??= { renders: 0, mounts: 0, time: 0 });
      total.renders += slot.renders;
      total.mounts += slot.mounts;
      total.time += slot.time;
    }
    if (index < limit) {
      const top = Object.entries(commit.stats)
        .sort((a, b) => b[1].time - a[1].time)
        .slice(0, 6)
        .map(
          ([name, slot]) => `${name}(${slot.renders}r/${slot.mounts}m ${slot.time.toFixed(1)}ms)`,
        )
        .join(' ');
      console.log(
        `  #${index} +${(commit.at - t0).toFixed(0)}ms renders=${renders} mounts=${mounts} self=${time.toFixed(0)}ms actual=${commit.actual.toFixed(0)}ms :: ${top}`,
      );
      if (renders > 300) {
        for (const [name, reasons] of Object.entries(commit.why)) {
          const line = Object.entries(reasons)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([reason, n]) => `${reason}x${n}`)
            .join('  ');
          console.log(`      why ${name.padEnd(20)} ${line}`);
        }
      }
    }
  }
  console.log('  totals by self time:');
  for (const [name, slot] of Object.entries(totals)
    .sort((a, b) => b[1].time - a[1].time)
    .slice(0, 40)) {
    console.log(
      `    ${name.padEnd(36)} renders=${String(slot.renders).padStart(6)} mounts=${String(slot.mounts).padStart(6)} self=${slot.time.toFixed(1)}ms`,
    );
  }
}

test('submit on a long thread', async ({ page }) => {
  test.setTimeout(10 * 60 * 1000);
  const { count, lastText } = await seed();
  console.log(`seeded ${count} messages (${SOURCE ?? 'synthetic'}), flat=${FLAT}`);
  await page.addInitScript((flat: boolean) => {
    localStorage.setItem('textToSpeech', 'false');
    localStorage.setItem('LC_FLAT_THREAD', flat ? 'true' : 'false');
  }, FLAT);
  await page.addInitScript({ content: PROBE });
  await page.goto(`/c/${CONVO.id}`, { timeout: 180_000 });
  if (lastText) {
    await expect(
      messagesView(page).getByRole('heading', { name: lastText, exact: true }).first(),
    ).toBeAttached({ timeout: 120_000 });
  }
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  console.log(`DOM elements after load: ${nodes}`);

  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 100 });
  await submit(page, `lag-timing-${Date.now()}`, async () => {
    await session.send('Profiler.start');
  });
  await page.waitForTimeout(PROFILE_MS);
  const { profile } = await session.send('Profiler.stop');
  const timing = await page.evaluate(() => window.__LAG__);
  reportTimeline('timing pass (no fiber walk)', timing);
  const summary = summarizeProfile(profile as unknown as Parameters<typeof summarizeProfile>[0]);
  console.log(`\n--- CPU self time (first ${PROFILE_MS}ms after Enter) ---`);
  for (const [key, ms] of summary.self) console.log(`  ${ms.toFixed(1).padStart(8)}ms  ${key}`);
  console.log(`--- CPU inclusive time (first ${PROFILE_MS}ms after Enter) ---`);
  for (const [key, ms] of summary.inclusive)
    console.log(`  ${ms.toFixed(1).padStart(8)}ms  ${key}`);
  await waitForTurnEnd(page);

  await page.evaluate(() => {
    window.__LAG__.tally = true;
  });
  await submit(page, `lag-tally-${Date.now()}`);
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(800);
  const early = await page.evaluate(() => {
    const snapshot = window.__LAG__;
    return { ...snapshot, commits: snapshot.commits.slice() };
  });
  reportCommits('submit commits (first 800ms after Stop visible)', early, 40);
  await waitForTurnEnd(page);
  const full = await page.evaluate(() => window.__LAG__);
  reportCommits('whole turn (submit + stream + finalize)', full, 0);
});

test.afterAll(async () => {
  await deleteMessagesByConversation([CONVO.id]);
  await deleteConversations([CONVO.id]);
});
