import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * The account menu is an Ariakit menu, and its dividers are that menu's own separators: exposed
 * as separators inside the menu, drawn as a 1px rule, and skipped by the arrow keys.
 */
test('the account menu draws its dividers as menu separators @scenario:account-menu-separators', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  /** Mobile keeps the account menu in the drawer. */
  await openSidebar(page);
  await page.getByTestId('nav-user').filter({ visible: true }).first().click();

  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const separators = menu.getByRole('separator');
  await expect(separators.first()).toBeVisible();
  expect(await separators.count()).toBeGreaterThanOrEqual(2);
  for (const separator of await separators.all()) {
    const box = await separator.boundingBox();
    expect(box?.height).toBeCloseTo(1, 0);
  }

  const items = menu.getByRole('menuitem');
  await items.first().focus();
  const count = await items.count();
  for (let step = 1; step < count; step++) {
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator(':focus')).toHaveRole('menuitem');
  }
});
