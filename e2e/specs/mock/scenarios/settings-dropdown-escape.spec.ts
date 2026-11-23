import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * Escape walks back one level at a time in the Settings dialog: the first press closes an open
 * dropdown list and leaves Settings where it was, the second closes Settings.
 */
test('Escape in a Settings dropdown closes the list before the dialog @scenario:settings-dropdown-escape', async ({
  page,
}) => {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  /** Mobile keeps the account menu in the drawer. */
  await openSidebar(page);
  await page.getByTestId('nav-user').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  const dialog = page.getByRole('dialog');
  const clock = dialog.getByRole('combobox', { name: /clock/i }).first();
  await dialog.getByRole('tab', { name: /general/i }).click();
  await expect(clock).toBeVisible();

  await clock.click();
  const listbox = page.locator('[role="listbox"]:not([hidden])');
  await expect(listbox).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(listbox).toBeHidden();
  await expect(clock).toBeVisible();
  await expect(clock).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(clock).toBeHidden();
});
