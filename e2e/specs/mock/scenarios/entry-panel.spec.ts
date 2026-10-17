import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * Entering the app, by a new visit, a reload or a tab opened from it, lands on chat history
 * whatever panel was open before, while the sidebar crossing the mobile breakpoint keeps it.
 */

test.describe('sidebar panel on entry', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a returning visit lands on chat history, not the last persisted panel @scenario:entry-lands-on-chat-history', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('unifiedSidebarExpanded', JSON.stringify(true));
      localStorage.setItem('side:active-panel', 'bookmarks');
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId('nav-panel-conversations')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('nav-panel-bookmarks')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a reload lands on chat history @scenario:entry-reload-lands-on-chat', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('unifiedSidebarExpanded', JSON.stringify(true));
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const bookmarks = page.getByTestId('nav-panel-bookmarks');
    await bookmarks.click();
    await expect(bookmarks).toHaveAttribute('aria-pressed', 'true');

    await page.reload();

    await expect(page.getByTestId('nav-panel-conversations')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('nav-panel-bookmarks')).toHaveAttribute('aria-pressed', 'false');
  });

  test('a tab opened from the app lands on chat history @scenario:entry-opened-tab-lands-on-chat', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('unifiedSidebarExpanded', JSON.stringify(true));
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const bookmarks = page.getByTestId('nav-panel-bookmarks');
    await bookmarks.click();
    await expect(bookmarks).toHaveAttribute('aria-pressed', 'true');

    const [opened] = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate((path) => {
        window.open(path, '_blank');
      }, NEW_CHAT_PATH),
    ]);

    await expect(opened.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 30000,
    });
    await expect(opened.getByTestId('nav-panel-conversations')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(opened.getByTestId('nav-panel-bookmarks')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await opened.reload();

    await expect(opened.getByTestId('nav-panel-conversations')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(opened.getByTestId('nav-panel-bookmarks')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('crossing the mobile breakpoint keeps the chosen panel @scenario:entry-resize-keeps-panel', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('unifiedSidebarExpanded', JSON.stringify(true));
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const bookmarks = page.getByTestId('nav-panel-bookmarks');
    await bookmarks.click();
    await expect(bookmarks).toHaveAttribute('aria-pressed', 'true');

    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.getByTestId('nav-panel-bookmarks')).toHaveCount(1);
    await expect(page.getByTestId('nav-panel-bookmarks')).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.getByTestId('nav-panel-bookmarks')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('nav-panel-conversations')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
