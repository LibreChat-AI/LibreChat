import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { openSidebar } from './sidebar';

/**
 * On small screens the sidebar is a drawer that Escape collapses. It only does so when
 * nothing above it took the Escape first (`assistant-delete-dialog-dismiss` covers a dialog
 * opened from the drawer keeping it open).
 */

async function drawerOpen(page: Page): Promise<boolean> {
  const closers = page.getByRole('button', { name: 'Close sidebar' });
  const count = await closers.count();
  for (let index = 0; index < count; index++) {
    if (await closers.nth(index).isVisible()) {
      return true;
    }
  }
  return false;
}

test('Escape with nothing open above it collapses the mobile drawer @scenario:drawer-escape-collapses', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'The drawer exists on small screens only');
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await openSidebar(page);
  expect(await drawerOpen(page)).toBe(true);

  await page.keyboard.press('Escape');
  await expect.poll(() => drawerOpen(page)).toBe(false);
});
