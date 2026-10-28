import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { resetPinnedState } from './pinned.helpers';
const modelTrigger = (page: Page) => page.getByRole('button', { name: 'Select a model' }).first();

async function openModelSearch(page: Page, query: string) {
  await modelTrigger(page).click();
  const search = page.locator('#model-search');
  await expect(search).toBeVisible();
  await search.fill(query);
  await expect(page.getByRole('option').first()).toBeVisible();
  return search;
}

test.describe('model selector search', () => {
  test.afterEach(async ({ page }) => {
    await resetPinnedState(page);
  });
  test('keyboard navigation reaches every rendered search result @scenario:model-selector-search-keyboard-navigation-reaches-every-rendered-result', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const search = await openModelSearch(page, 'mock');
    const options = page.locator('[role="option"]');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThan(1);

    for (let index = 0; index < Math.min(optionCount, 3); index++) {
      await search.press('ArrowDown');
      await expect(search).toBeFocused();
    }
    const announcement = page.locator('[role="alert"]').first();
    const initialAnnouncement = await announcement.textContent();
    await search.fill('zzzz-no-results');
    await expect(announcement).toHaveText(/no results/i);
    expect(await announcement.textContent()).not.toBe(initialAnnouncement);
  });

  test('pinning a search result is keyboard reachable @scenario:model-selector-search-result-pin-is-keyboard-reachable', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await resetPinnedState(page);
    const search = await openModelSearch(page, 'mock');
    const modelRows = page.getByRole('option').filter({ hasText: /mock-model-[a-z]/i });
    const tabbablePin = modelRows.locator('button[aria-label="Pin"][tabindex="0"]');

    for (
      let index = 0, optionCount = await page.getByRole('option').count();
      index <= optionCount && (await tabbablePin.count()) === 0;
      index++
    ) {
      await search.press('ArrowDown');
    }
    await expect(tabbablePin).toHaveCount(1);
    const activeRow = tabbablePin.locator('xpath=ancestor::*[@role="option"][1]');
    const modelName = (await activeRow.innerText()).match(/mock-model-[a-z]/i)?.[0];
    expect(modelName).toBeTruthy();
    const row = page.getByRole('option').filter({ hasText: modelName! }).first();
    await page.keyboard.press('Tab');
    await expect(tabbablePin).toBeFocused();
    await tabbablePin.press('Enter');
    await expect(row.locator('button[aria-label="Unpin"]')).toHaveCount(1);
  });

  test('search options expose one global position sequence @scenario:model-selector-search-options-report-global-positions', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await openModelSearch(page, 'mock');

    const options = page.locator('[role="option"][aria-posinset]');
    await expect(options.first()).toBeVisible();
    const metadata = await options.evaluateAll((nodes) =>
      nodes.map((node) => ({
        position: Number(node.getAttribute('aria-posinset')),
        setSize: Number(node.getAttribute('aria-setsize')),
      })),
    );
    expect(metadata.length).toBeGreaterThan(0);
    expect(new Set(metadata.map((entry) => entry.setSize)).size).toBe(1);
    expect(metadata.map((entry) => entry.position)).toEqual(
      Array.from({ length: metadata.length }, (_, index) => index + 1),
    );
  });

  test('mobile search rows keep their controls inside the popover @scenario:model-selector-search-row-fits-mobile-popover', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await openModelSearch(page, 'mock');

    const row = page
      .locator('[role="option"]')
      .filter({
        has: page.locator('button[aria-label="Pin"]'),
      })
      .first();
    const pin = row.locator('button[aria-label="Pin"]');
    const menu = page.locator('[role="listbox"]').first();
    const rowBox = await row.boundingBox();
    const pinBox = await pin.boundingBox();
    const menuBox = await menu.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(pinBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(rowBox!.x).toBeGreaterThanOrEqual(menuBox!.x);
    expect(pinBox!.x + pinBox!.width).toBeLessThanOrEqual(menuBox!.x + menuBox!.width + 1);
    expect(pinBox!.x + pinBox!.width).toBeLessThanOrEqual(390);
  });
});
