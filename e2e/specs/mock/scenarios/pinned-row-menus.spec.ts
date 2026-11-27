import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { SeededPin } from './pinned.helpers';
import {
  PINNED_REGION,
  isConversationPinned,
  removePins,
  resetPinnedState,
  seedPinnedConversations,
} from './pinned.helpers';
import { NEW_CHAT_PATH } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * Every pinned row the pointer crosses keeps its overflow trigger, while the menu's actions
 * mount only once that menu is used. These check the menu still opens and acts from each
 * input: a mouse that swept the section first, the keyboard alone, and a touch tap.
 */
const MENU_LABEL = 'Conversation Menu Options';

const pinnedRow = (page: Page, title: string): Locator =>
  page
    .getByRole('region', { name: PINNED_REGION })
    .getByTestId('convo-item')
    .filter({ hasText: title })
    .filter({ visible: true })
    .first();

async function seedAndOpen(page: Page, label: string, count: number): Promise<SeededPin[]> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await resetPinnedState(page);
  const stamp = Date.now();
  const pins = await seedPinnedConversations(
    Array.from({ length: count }, (_, index) => `${label} ${stamp} ${index + 1}`),
  );
  await page.reload();
  await openSidebar(page);
  await expect(pinnedRow(page, pins[0].title)).toBeVisible({ timeout: 15000 });
  return pins;
}

async function expectUnpinned(page: Page, pin: SeededPin) {
  await expect.poll(() => isConversationPinned(pin.conversationId)).toBe(false);
  await expect(pinnedRow(page, pin.title)).toHaveCount(0);
}

test.describe('pinned row menus on a pointer device', () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test('a pinned row menu opens and acts by mouse after a sweep and by keyboard alone @scenario:pinned-row-menu-mouse-and-keyboard', async ({
    page,
  }) => {
    let pins: SeededPin[] = [];
    try {
      pins = await seedAndOpen(page, 'Menu input', 6);

      for (const pin of pins) {
        await pinnedRow(page, pin.title).hover();
      }
      await page.mouse.move(900, 450);

      const mouseRow = pinnedRow(page, pins[1].title);
      await mouseRow.hover();
      const mouseTrigger = mouseRow.getByRole('button', { name: MENU_LABEL });
      await expect(mouseTrigger).toBeVisible();
      await mouseTrigger.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Unpin' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(mouseTrigger).toBeFocused();

      await page.mouse.move(900, 450);
      const keyboardRow = pinnedRow(page, pins[3].title);
      const keyboardTrigger = keyboardRow.getByRole('button', { name: MENU_LABEL });
      await keyboardRow.getByRole('button', { name: new RegExp(`^${pins[3].title}`) }).focus();
      for (let step = 0; step < 6; step++) {
        if (await keyboardTrigger.evaluate((node) => node === document.activeElement)) {
          break;
        }
        await page.keyboard.press('Tab');
      }
      await expect(keyboardTrigger).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      const unpin = menu.getByRole('menuitem', { name: 'Unpin' });
      await expect(unpin).toBeVisible();
      await expect(unpin).toBeFocused();
      await page.keyboard.press('Enter');
      await expectUnpinned(page, pins[3]);
    } finally {
      await removePins(pins);
    }
  });
});

test.describe('pinned row menus on touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a pinned row menu opens and acts from a tap @scenario:pinned-row-menu-touch', async ({
    page,
  }) => {
    let pins: SeededPin[] = [];
    try {
      pins = await seedAndOpen(page, 'Menu touch', 3);

      const row = pinnedRow(page, pins[1].title);
      const trigger = row.getByRole('button', { name: MENU_LABEL });
      await expect(trigger).toBeVisible();
      await trigger.tap();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem', { name: 'Unpin' }).tap();
      await expectUnpinned(page, pins[1]);
    } finally {
      await removePins(pins);
    }
  });
});
