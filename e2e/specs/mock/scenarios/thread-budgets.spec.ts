import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import type { Thread } from '../thread';
import {
  settled,
  mountSteps,
  readThrough,
  countRenders,
  installCounts,
  countElements,
  countListeners,
} from '../counts';
import { clearUserConversations } from '../db';
import { getE2EUser } from '../../../setup/user';
import { sendMessage } from '../helpers';
import { removeThread, seedThread } from '../thread';

/**
 * What a long agent conversation costs the page, held to budgets that do not depend on the
 * machine: how many elements it holds, how it mounts, how much renders while a reply streams
 * beside it, and what it leaves listening on the document.
 *
 * Each budget is a ceiling a little above what the app measures today, so a change that makes
 * every row heavier, or makes rows the reader is not looking at do work, fails here before it
 * merges. A run prints what it measured and records it on the test. Raise a budget only for a
 * cost the change means to add, and say so in the pull request; lower it after a change that
 * removes one, so the gain is kept.
 */

const ROWS = 250;

const BUDGETS = {
  /** Elements in the thread once it has mounted, before the reader moves: 23,015. */
  opened: 24_150,
  /** Elements in it once the reader has scrolled back through every row: 28,631. */
  read: 30_050,
  /** Rows the thread adds in one frame as it mounts. */
  step: 32,
  /** Listeners on `document` and `window` once every row has been read: 131. */
  listeners: 138,
  /** Component renders in one streamed frame of a reply: 59. */
  frame: 62,
  /** Of those, the renders outside every row: 31. */
  around: 33,
  /**
   * Renders inside the rows that were already there, over the whole reply: 575 to 591. They are
   * the toolbars of the rows near the reader, rendered when the run starts and when it ends,
   * and the one component in each that reads the chat for them, at each step of the send.
   */
  earlier: 700,
};

type Budget = keyof typeof BUDGETS;

/** Holds every count to its budget, so one run reports all that a change went over. */
function hold(info: TestInfo, measured: Partial<Record<Budget, number>>): void {
  const names = Object.keys(measured) as Budget[];
  const line = names.map((name) => `${name} ${measured[name]}/${BUDGETS[name]}`).join(', ');
  console.log(`thread budgets (measured/budget): ${line}`);
  for (const name of names) {
    info.annotations.push({
      type: `measured ${name}`,
      description: `${measured[name]} of ${BUDGETS[name]}`,
    });
    expect
      .soft(measured[name], `${name}: measured ${measured[name]}, budget ${BUDGETS[name]}`)
      .toBeLessThanOrEqual(BUDGETS[name]);
  }
}

async function open(page: Page, thread: Thread): Promise<void> {
  await installCounts(page);
  await page.goto(`/c/${thread.conversationId}`);
  const rows = page.locator(`[data-conversation-id="${thread.conversationId}"] .message-render`);
  await expect(rows).toHaveCount(thread.rows, { timeout: 60_000 });
  await expect(rows.last()).toBeInViewport();
}

test.describe('a long agent conversation, by count', () => {
  /** The counts depend on what fits in the window. */
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  test.setTimeout(180_000);

  let thread: Thread;

  test.beforeEach(async () => {
    /** Each conversation in the sidebar listens on the window: leave only this one there. */
    await clearUserConversations(getE2EUser().email);
    thread = await seedThread(ROWS);
  });

  test.afterEach(async () => {
    await removeThread(thread);
  });

  test('mounts in steps, and what it holds stays within budget @scenario:long-thread-document-stays-within-budget', async ({
    page,
  }, info) => {
    await open(page, thread);
    const steps = await mountSteps(page);
    const opened = await settled(page, () => countElements(page));

    await readThrough(page);
    const read = await settled(page, () => countElements(page));
    const byType = await countListeners(page);
    const listeners = Object.values(byType).reduce((sum, count) => sum + count, 0);

    info.annotations.push({ type: 'listeners by type', description: JSON.stringify(byType) });
    console.log(`thread listeners: ${JSON.stringify(byType)}`);
    /** The steps account for every row: none was in the document before the count began. */
    expect(steps.reduce((sum, step) => sum + step, 0)).toBe(ROWS);
    hold(info, { opened, read, step: Math.max(...steps), listeners });
  });

  test('a reply streaming beside it renders within budget @scenario:long-thread-reply-renders-within-budget', async ({
    page,
  }, info) => {
    await open(page, thread);
    await settled(page, () => countElements(page));

    const finish = await countRenders(page);
    await sendMessage(page, `E2E_SLOW_REPLY:${randomUUID().slice(0, 8)}`);
    const stop = page.getByTestId('stop-generation-button');
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(stop).toBeHidden({ timeout: 60_000 });
    const { commits, frame, around, earlier } = await finish();

    info.annotations.push({ type: 'commits', description: String(commits) });
    /** The reply streamed: a count over no commits would pass any budget. */
    expect(commits).toBeGreaterThan(100);
    expect(frame).toBeGreaterThan(0);
    hold(info, { frame, around, earlier });
  });
});
