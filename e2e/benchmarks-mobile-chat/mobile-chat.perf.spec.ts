import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import {
  clearUserConversations,
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../specs/mock/db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../specs/mock/helpers';
import { getE2EUser } from '../setup/user';
import {
  attachBrowserPhases,
  createBrowserProbe,
  formatBrowserPhase,
  installBrowserPerf,
} from '../perf/browser';
import type { BrowserPhase } from '../perf/browser';
import {
  attachSnapshot,
  installReactScan,
  resetPerf,
  snapshotPerf,
  topComponents,
  totals,
} from '../perf/scan';
import type { PerfSnapshot } from '../perf/scan';
import { buildStressMessages, ROWS, STREAM_END_MARKER, TURNS } from './payload';

const userEmail = getE2EUser().email;
const FIXTURES = [
  { id: randomUUID(), label: 'raw', title: 'Mobile performance raw metrics' },
  { id: randomUUID(), label: 'scan', title: 'Mobile performance react scan' },
] as const;
const CONTINUATIONS = 3;

interface ScenarioResults {
  browser: Record<string, BrowserPhase>;
  scan: Record<string, PerfSnapshot>;
}

function messageRows(page: Page) {
  return messagesView(page).locator('.message-render');
}

async function stressScroll(page: Page): Promise<void> {
  const scroller = messagesView(page).locator('.scrollbar-gutter-stable');
  await scroller.evaluate(async (element) => {
    const scrollTo = (target: number) =>
      new Promise<void>((resolve) => {
        const startedAt = performance.now();
        const from = element.scrollTop;
        const duration = 450;
        const step = (now: number) => {
          const progress = Math.min(1, (now - startedAt) / duration);
          element.scrollTop = from + (target - from) * progress;
          if (progress < 1) {
            requestAnimationFrame(step);
            return;
          }
          resolve();
        };
        requestAnimationFrame(step);
      });
    for (let pass = 0; pass < 4; pass += 1) {
      await scrollTo(0);
      await scrollTo(element.scrollHeight);
    }
  });
}

async function runPhase(
  name: string,
  page: Page,
  results: ScenarioResults,
  reactScan: boolean,
  action: () => Promise<void>,
): Promise<void> {
  const probe = await createBrowserProbe(page);
  if (reactScan) {
    await resetPerf(page);
  }
  await probe.start();
  await action();
  results.browser[name] = await probe.finish();
  if (reactScan) {
    results.scan[name] = await snapshotPerf(page);
  }
}

async function runScenario(
  page: Page,
  testInfo: TestInfo,
  fixture: (typeof FIXTURES)[number],
  reactScan: boolean,
): Promise<void> {
  await installBrowserPerf(page);
  if (reactScan) {
    await installReactScan(page);
  }

  await page.goto(NEW_CHAT_PATH, { timeout: 120_000 });
  const results: ScenarioResults = { browser: {}, scan: {} };

  await runPhase('idle-empty', page, results, reactScan, async () => {
    await page.waitForTimeout(3_000);
  });

  await runPhase('load', page, results, reactScan, async () => {
    await page.goto(`/c/${fixture.id}`, { timeout: 120_000 });
    await expect(messageRows(page)).toHaveCount(ROWS, { timeout: 120_000 });
  });

  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

  await runPhase('idle-long', page, results, reactScan, async () => {
    await page.waitForTimeout(3_000);
  });

  await runPhase('scroll', page, results, reactScan, async () => {
    await stressScroll(page);
  });

  await runPhase('continue', page, results, reactScan, async () => {
    for (let turn = 1; turn <= CONTINUATIONS; turn += 1) {
      await sendMessage(page, `Continue mobile stress turn ${turn}`);
      await expect(messagesView(page).getByText(STREAM_END_MARKER, { exact: true })).toHaveCount(
        turn,
        { timeout: 90_000 },
      );
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
        timeout: 30_000,
      });
    }
  });
  await expect(messageRows(page)).toHaveCount(ROWS + CONTINUATIONS * 2, { timeout: 30_000 });

  await runPhase('typing', page, results, reactScan, async () => {
    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.pressSequentially(
      'Typing after a three-hundred-message transcript should keep the transcript quiet.',
      { delay: 10 },
    );
  });

  console.log(
    `\n=== Mobile chat stress: ${reactScan ? 'react-scan diagnostic' : 'raw browser metrics'} ` +
      `(390x664 viewport, 390x844 screen, ${TURNS} seeded turns / ${ROWS} rows, ` +
      `${CONTINUATIONS} continuations) ===`,
  );
  for (const [name, phase] of Object.entries(results.browser)) {
    console.log(formatBrowserPhase(name, phase));
  }
  if (reactScan) {
    let capturedRenders = 0;
    for (const [name, snapshot] of Object.entries(results.scan)) {
      const phaseTotals = totals(snapshot);
      capturedRenders += phaseTotals.renders;
      console.log(
        `${name} react renders=${phaseTotals.renders} render-time=${phaseTotals.time.toFixed(0)}ms`,
      );
      for (const line of topComponents(snapshot, 12)) {
        console.log(`  ${line}`);
      }
      await attachSnapshot(testInfo, `${name}-react-scan.json`, snapshot, {
        seededRows: ROWS,
        continuations: CONTINUATIONS,
      });
    }
    expect(capturedRenders).toBeGreaterThan(0);
  }
  await attachBrowserPhases(testInfo, 'browser-metrics.json', results.browser);

  for (const phase of Object.values(results.browser)) {
    expect(phase.elapsedMs).toBeGreaterThan(0);
    expect(phase.taskMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(phase.busyPercent)).toBe(true);
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('iPhone-sized long-chat performance', () => {
  test.beforeAll(async () => {
    await clearUserConversations(userEmail);
    await seedConversations(
      userEmail,
      FIXTURES.map((fixture, index) => ({
        conversationId: fixture.id,
        title: fixture.title,
        updatedAt: new Date(Date.now() - index * 60_000),
      })),
    );
    for (const fixture of FIXTURES) {
      await seedMessages(userEmail, fixture.id, buildStressMessages(fixture.label));
    }
  });

  test.afterAll(async () => {
    const ids = FIXTURES.map((fixture) => fixture.id);
    await deleteMessagesByConversation(ids);
    await deleteConversations(ids);
  });

  test('captures browser CPU proxies without react-scan overhead', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60 * 1000);
    await runScenario(page, testInfo, FIXTURES[0], false);
  });

  test('attributes renders with react-scan enabled', async ({ page }, testInfo) => {
    test.setTimeout(10 * 60 * 1000);
    await runScenario(page, testInfo, FIXTURES[1], true);
  });
});
