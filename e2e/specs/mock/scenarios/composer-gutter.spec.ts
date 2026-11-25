import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, mockReply, sendMessage } from '../helpers';

/**
 * From `sm` up the composer keeps 1rem clear of each edge of the chat column, measured
 * against the column rather than the window, so it holds while the persistent sidebar
 * takes part of the window. A phone, and a user who maximized the chat space, keep the
 * full width.
 *
 * 1024px is the narrowest common desktop width that shows the persistent sidebar; with
 * it open at its 360px minimum the column is about 660px, under the composer's 48rem
 * cap, which is where the composer used to run to the column's edges.
 */

const SIDEBAR_WIDTH = 360;
const COMPOSER = 'form:has(#prompt-textarea)';
/** 1rem a side, less half the column's 0.5rem scrollbar band on the welcome screen. */
const MIN_GAP = 16 - 5;

test.use({ viewport: { width: 1024, height: 800 } });

async function openSidebar(page: Page) {
  await page.addInitScript((width) => {
    localStorage.setItem('unifiedSidebarExpanded', 'true');
    localStorage.setItem('side:width', String(width));
  }, SIDEBAR_WIDTH);
}

type Gaps = { left: number; right: number; width: number; column: number };

async function gapsWithinColumn(page: Page): Promise<Gaps> {
  return page.evaluate((target) => {
    const column = document.querySelector('main')!.getBoundingClientRect();
    const box = document.querySelector(target)!.getBoundingClientRect();
    return {
      left: Math.round(box.left - column.left),
      right: Math.round(column.right - box.right),
      width: Math.round(box.width),
      column: Math.round(column.width),
    };
  }, COMPOSER);
}

async function openLanding(page: Page, narrowColumn = true) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.locator(COMPOSER)).toBeVisible({ timeout: 30000 });
  if (narrowColumn) {
    /** The sidebar opens with a transform transition; wait for the column to settle. */
    await expect
      .poll(async () => (await gapsWithinColumn(page)).column, { timeout: 10000 })
      .toBeLessThan(1024 - SIDEBAR_WIDTH + 8);
  }
}

test.describe('composer gutter against the chat column', () => {
  test('the composer keeps clear of the column edges with the sidebar open @scenario:composer-keeps-clear-of-the-column-edges', async ({
    page,
  }) => {
    await openSidebar(page);
    await openLanding(page);
    const gaps = await gapsWithinColumn(page);
    expect(Math.min(gaps.left, gaps.right)).toBeGreaterThanOrEqual(MIN_GAP);
    /** A gutter, not a share of the column: no more than 1rem a side plus the band. */
    expect(gaps.left + gaps.right).toBeLessThanOrEqual(2 * 16 + 8 + 2);
  });

  test('the composer keeps its width and edge from the welcome screen into the conversation @scenario:composer-gutter-holds-into-the-conversation', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await openSidebar(page);
    await openLanding(page);
    const before = await gapsWithinColumn(page);

    await sendMessage(page, 'Composer gutter check');
    await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
    await expect
      .poll(async () => {
        const after = await gapsWithinColumn(page);
        return [after.width, after.left];
      })
      .toEqual([before.width, before.left]);
  });

  test('a maximized chat space keeps the composer across the full column @scenario:maximized-composer-has-no-gutter', async ({
    page,
  }) => {
    await openSidebar(page);
    await page.addInitScript(() => localStorage.setItem('maximizeChatSpace', 'true'));
    await openLanding(page);
    const gaps = await gapsWithinColumn(page);
    expect(Math.min(gaps.left, gaps.right)).toBeLessThan(MIN_GAP);
  });
});

test.describe('composer on a phone', () => {
  test.use({ viewport: { width: 375, height: 740 } });

  test('a phone keeps the composer across the full column @scenario:phone-composer-has-no-gutter', async ({
    page,
  }) => {
    await openLanding(page, false);
    const gaps = await gapsWithinColumn(page);
    /** Only the column's scrollbar band (0.5rem) may stand between the form and an edge. */
    expect(gaps.left).toBeLessThanOrEqual(8);
    expect(gaps.right).toBeLessThanOrEqual(8);
  });
});
