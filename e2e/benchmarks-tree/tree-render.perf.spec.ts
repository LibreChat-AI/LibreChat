import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { BrowserPhase } from '../perf/browser';
import type { PerfSnapshot } from '../perf/scan';
import { createBrowserProbe, installBrowserPerf } from '../perf/browser';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../specs/mock/db';
import { MOCK_ENDPOINTS, messagesView, sendMessage } from '../specs/mock/helpers';
import { getE2EUser } from '../setup/user';
import {
  attachSnapshot,
  buildTallySetup,
  installReactScan,
  longTaskStats,
  resetPerf,
  snapshotPerf,
  topComponents,
  totals,
} from '../perf/scan';
import {
  ROWS,
  SHALLOW_BRANCH_CONTINUATION_TURNS,
  SHALLOW_BRANCH_TURN,
  TURNS,
  altHeading,
  buildTreeMessages,
  turnHeading,
} from './payload';

/**
 * Message-tree render benchmark (react-scan).
 *
 * Measures what the tree-shaped render path costs on a long thread: renders
 * and render time per streamed delta, and per sibling switch at the leaf and
 * near the root. The numbers are printed and attached; the assertions only
 * guard the harness itself.
 */

const userEmail = getE2EUser().email;
/** `TREE_PERF_SCAN=0` drops react-scan so long-task totals carry no instrumentation overhead. */
const WITH_SCAN = process.env.TREE_PERF_SCAN !== '0';
const VARIANTS = [
  { name: 'tree (recursive MultiMessage)', flat: false, label: 'T' },
  { name: 'flat (index + path list)', flat: true, label: 'F' },
] as const;
type Variant = (typeof VARIANTS)[number];
const CONVOS = new Map(
  VARIANTS.map((variant) => [
    variant.label,
    { id: randomUUID(), label: variant.label, title: `Tree render bench ${variant.label}` },
  ]),
);
const ENDPOINT = MOCK_ENDPOINTS[0];
const KEY_COMPONENTS = [
  'MultiMessage',
  'MessageRender',
  'ContentRender',
  'Message',
  'MessageContent',
  'MarkdownBlock',
  'SiblingSwitch',
  'MessagesViewContent',
];

async function seedTree(CONVO: { id: string; label: string; title: string }): Promise<void> {
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) {
      throw new Error(`E2E seed: user "${userEmail}" not found`);
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
    const start = Date.now() - ROWS * 2000;
    const docs = buildTreeMessages(CONVO.label).map((message, index) => ({
      ...message,
      conversationId: CONVO.id,
      user: userId,
      endpoint: ENDPOINT.label,
      model: ENDPOINT.model,
      error: false,
      unfinished: false,
      createdAt: new Date(start + index * 1000),
      updatedAt: new Date(start + index * 1000),
      __v: 0,
    }));
    await db.collection('messages').insertMany(docs);
  });
}

function heading(page: Page, text: string) {
  return messagesView(page).getByRole('heading', { name: text, exact: true }).first();
}

type ResourceSample = {
  heapMB: number;
  heapTotalMB: number;
  nodes: number;
  listeners: number;
  rendererCpuS: number;
};

/**
 * Process-level cost per phase: JS heap after a forced GC (retained memory,
 * not allocation churn), DOM node and listener counts, and the renderer
 * process CPU time consumed during the phase (all threads, so compositor and
 * GC work count, which the main-thread task total above leaves out).
 */
async function createResourceProbe(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.enable');
  await session.send('Performance.enable');
  const browser = page.context().browser();
  const browserSession = browser ? await browser.newBrowserCDPSession() : null;
  const rendererCpu = async () => {
    if (!browserSession) {
      return 0;
    }
    const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
    return processInfo
      .filter((info) => info.type === 'renderer')
      .reduce((sum, info) => sum + info.cpuTime, 0);
  };
  let cpuStart = 0;
  return {
    async start() {
      cpuStart = await rendererCpu();
    },
    async sample(): Promise<ResourceSample> {
      const cpuEnd = await rendererCpu();
      await session.send('HeapProfiler.collectGarbage');
      const { metrics } = await session.send('Performance.getMetrics');
      const metric = (name: string) => metrics.find((entry) => entry.name === name)?.value ?? 0;
      return {
        heapMB: metric('JSHeapUsedSize') / 1048576,
        heapTotalMB: metric('JSHeapTotalSize') / 1048576,
        nodes: metric('Nodes'),
        listeners: metric('JSEventListeners'),
        rendererCpuS: cpuEnd - cpuStart,
      };
    },
  };
}

function report(
  name: string,
  snapshot: PerfSnapshot,
  browser: BrowserPhase,
  extra: Record<string, number> = {},
  resources?: ResourceSample,
) {
  const sum = totals(snapshot);
  const tasks = longTaskStats(snapshot);
  console.log(`\n=== ${name} (${Math.ceil(snapshot.elapsedMs)}ms wall) ===`);
  console.log(
    `total renders=${sum.renders} render-time=${sum.time.toFixed(0)}ms ` +
      `longtask-total=${tasks.total.toFixed(0)}ms worst-longtask=${tasks.worst.toFixed(0)}ms`,
  );
  console.log(
    `cdp: task=${browser.taskMs.toFixed(0)}ms script=${browser.scriptMs.toFixed(0)}ms ` +
      `layout=${browser.layoutMs.toFixed(0)}ms style=${browser.styleMs.toFixed(0)}ms ` +
      `busy=${browser.busyPercent.toFixed(1)}% layouts=${browser.layoutCount} ` +
      `heap=${(browser.heapEndBytes / 1048576).toFixed(0)}MB nodes=${browser.nodesEnd}`,
  );
  if (resources) {
    console.log(
      `resources: rendererCPU=${resources.rendererCpuS.toFixed(2)}s ` +
        `heapAfterGC=${resources.heapMB.toFixed(1)}MB heapTotal=${resources.heapTotalMB.toFixed(0)}MB ` +
        `nodes=${resources.nodes} listeners=${resources.listeners}`,
    );
  }
  for (const [key, value] of Object.entries(extra)) {
    console.log(`${key}=${value}`);
  }
  console.log('key components:');
  for (const component of KEY_COMPONENTS) {
    const slot = snapshot.renders[component];
    console.log(
      `  ${component.padEnd(20)} renders=${String(slot?.count ?? 0).padStart(6)} time=${(slot?.time ?? 0).toFixed(1)}ms`,
    );
  }
  console.log('top components:');
  for (const line of topComponents(snapshot, 12)) {
    console.log(`  ${line}`);
  }
}

/** Rows the deep switch drops: the spine below the branch turn, less the alternate continuation. */
const DEEP_SWITCH_ROWS = ROWS - SHALLOW_BRANCH_TURN * 2 - SHALLOW_BRANCH_CONTINUATION_TURNS * 2;

async function clickSibling(page: Page, name: string, position: 'first' | 'last') {
  const buttons = page.getByRole('button', { name, exact: true });
  const button = position === 'first' ? buttons.first() : buttons.last();
  await button.dispatchEvent('click');
}

test.describe('message tree render perf (react-scan)', () => {
  test.beforeAll(async () => {
    for (const convo of CONVOS.values()) {
      await seedTree(convo);
    }
  });

  test.afterAll(async () => {
    const ids = Array.from(CONVOS.values()).map((convo) => convo.id);
    await deleteMessagesByConversation(ids);
    await deleteConversations(ids);
  });

  for (const variant of VARIANTS) {
    test(`${variant.name}: streaming and sibling switches on a long thread`, async ({
      page,
    }, testInfo) => {
      await runVariant(page, testInfo, variant);
    });
  }
});

async function runVariant(
  page: Page,
  testInfo: Parameters<Parameters<typeof test>[1]>[1],
  variant: Variant,
) {
  const CONVO = CONVOS.get(variant.label);
  if (!CONVO) {
    throw new Error('variant conversation missing');
  }
  {
    test.setTimeout(8 * 60 * 1000);
    if (WITH_SCAN) {
      await installReactScan(page, 'MultiMessage');
    } else {
      await page.addInitScript({ content: buildTallySetup('MultiMessage') });
    }
    await installBrowserPerf(page);
    const probe = await createBrowserProbe(page);
    const resourceProbe = await createResourceProbe(page);
    /** TTS mounts a src-less <audio> per row whose error event logs a React
     *  fiber dump through vite's console forwarding, which floods the
     *  terminal and stalls the page under measurement. */
    await page.addInitScript((flat: boolean) => {
      localStorage.setItem('textToSpeech', 'false');
      localStorage.setItem('LC_FLAT_THREAD', flat ? 'true' : 'false');
      const original = console.error.bind(console);
      console.error = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].startsWith('Error fetching audio')) {
          return;
        }
        original(...args);
      };
    }, variant.flat);
    console.log(`\n##### variant: ${variant.name} (react-scan ${WITH_SCAN ? 'on' : 'off'})`);

    /** The probe's page global comes from an init script, so it can only start
     *  once a document exists: the load phase's CDP totals begin at the load
     *  event, after the first commit. */
    await page.goto(`/c/${CONVO.id}`, { timeout: 180_000 });
    await probe.start();
    await resourceProbe.start();
    await expect(heading(page, turnHeading(CONVO.label, 1))).toBeAttached({ timeout: 120_000 });
    await expect(heading(page, turnHeading(CONVO.label, TURNS))).toBeAttached({
      timeout: 120_000,
    });
    await page.waitForTimeout(1000);
    const load = await snapshotPerf(page);
    report(
      'load (all rows mounted)',
      load,
      await probe.finish(),
      { rows: ROWS },
      await resourceProbe.sample(),
    );
    await attachSnapshot(testInfo, 'load.json', load, { rows: ROWS });

    await resetPerf(page);
    await probe.start();
    await resourceProbe.start();
    await sendMessage(page, 'E2E_SLOW_REPLY:tree');
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 120_000,
    });
    await page.waitForTimeout(500);
    const stream = await snapshotPerf(page);
    const streamBrowser = await probe.finish();
    const streamResources = await resourceProbe.sample();
    const flushes = stream.renders['ContentRender']?.count ?? 0;
    const multi = stream.renders['MultiMessage']?.count ?? 0;
    report(
      'stream (160 chunks @35ms into a ' + ROWS + '-row thread)',
      stream,
      streamBrowser,
      {
        'flushes(ContentRender renders)': flushes,
        'MultiMessage renders per flush': flushes > 0 ? Math.round((multi / flushes) * 10) / 10 : 0,
      },
      streamResources,
    );
    await attachSnapshot(testInfo, 'stream.json', stream, { rows: ROWS + 2, flushes });
    if (WITH_SCAN) {
      expect(flushes).toBeGreaterThan(5);
    }

    await resetPerf(page);
    await probe.start();
    await resourceProbe.start();
    await clickSibling(page, 'Previous sibling message', 'last');
    await expect(heading(page, altHeading(CONVO.label, TURNS))).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const leafPrev = await snapshotPerf(page);
    report(
      'switch leaf -> alternate (drops 2 rows)',
      leafPrev,
      await probe.finish(),
      {},
      await resourceProbe.sample(),
    );
    await attachSnapshot(testInfo, 'switch-leaf-prev.json', leafPrev, {});

    await resetPerf(page);
    await probe.start();
    await resourceProbe.start();
    await clickSibling(page, 'Next sibling message', 'last');
    await expect(heading(page, turnHeading(CONVO.label, TURNS))).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const leafNext = await snapshotPerf(page);
    report(
      'switch leaf -> spine (restores 2 rows)',
      leafNext,
      await probe.finish(),
      {},
      await resourceProbe.sample(),
    );
    await attachSnapshot(testInfo, 'switch-leaf-next.json', leafNext, {});

    await resetPerf(page);
    await probe.start();
    await resourceProbe.start();
    await clickSibling(page, 'Previous sibling message', 'first');
    await expect(heading(page, altHeading(CONVO.label, 3))).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const shallowPrev = await snapshotPerf(page);
    report(
      `switch turn ${SHALLOW_BRANCH_TURN} -> alternate (drops ~${DEEP_SWITCH_ROWS} rows)`,
      shallowPrev,
      await probe.finish(),
      {},
      await resourceProbe.sample(),
    );
    await attachSnapshot(testInfo, 'switch-shallow-prev.json', shallowPrev, {});

    await resetPerf(page);
    await probe.start();
    await resourceProbe.start();
    await clickSibling(page, 'Next sibling message', 'first');
    await expect(heading(page, turnHeading(CONVO.label, TURNS))).toBeAttached({
      timeout: 60_000,
    });
    await page.waitForTimeout(1000);
    const shallowNext = await snapshotPerf(page);
    report(
      `switch turn ${SHALLOW_BRANCH_TURN} -> spine (remounts ~${DEEP_SWITCH_ROWS} rows)`,
      shallowNext,
      await probe.finish(),
      {},
      await resourceProbe.sample(),
    );
    await attachSnapshot(testInfo, 'switch-shallow-next.json', shallowNext, {});
  }
}
