import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/** Resize from desktop to exercise the fallback before the drawer animator owns opening. */
test('opening the sidebar preserves focus moved during its delay @scenario:sidebar-preserves-deliberate-focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('unifiedSidebarExpanded', 'false'));
  await page.goto(NEW_CHAT_PATH);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const opener = page.getByTestId('header-open-sidebar-button');
  await expect(opener).toBeVisible();
  /** An installed clock keeps running until paused, so pausing "now" can land behind it. */
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 5_000);
  await opener.click();
  await page.clock.runFor(100);
  const close = page.getByTestId('close-sidebar-button');
  await expect(close).toBeVisible();
  const newChat = page.locator('#mobile-drawer').getByTestId('nav-new-chat-fab');
  await newChat.focus();
  await expect(newChat).toBeFocused();
  await page.clock.runFor(300);
  await expect(newChat).toBeFocused();
});
