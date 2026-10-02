import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * "New chat returns to the chat list" is a user preference the host reads and hands to the
 * sidebar. Both new-chat controls follow it: the desktop rail's and the mobile drawer's. With it
 * on, starting a chat from another panel brings the chat list back; with it off, the panel the
 * user was on stays.
 */

const OTHER_PANEL = 'Bookmarks';

async function load(page: Page, switchToHistory: boolean) {
  await page.addInitScript((value) => {
    localStorage.setItem('newChatSwitchToHistory', JSON.stringify(value));
    localStorage.setItem('unifiedSidebarExpanded', JSON.stringify(true));
    localStorage.removeItem('side:active-panel');
  }, switchToHistory);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
}

async function desktopNewChat(page: Page, switchToHistory: boolean) {
  await load(page, switchToHistory);
  const chats = page.getByTestId('nav-panel-conversations');
  const other = page.getByTestId('nav-panel-bookmarks');
  await other.click();
  await expect(other).toHaveAttribute('aria-pressed', 'true');

  await page.getByTestId('new-chat-button').click();
  await expect(page).toHaveURL(/\/c\/new$/);
  return { chats, other };
}

async function mobileNewChat(page: Page, switchToHistory: boolean) {
  await load(page, switchToHistory);
  const drawer = page.locator('#mobile-drawer');
  const openDrawer = async () => {
    if (!(await drawer.getByTestId('close-sidebar-button').isVisible())) {
      await page.getByTestId('header-open-sidebar-button').click();
    }
    await expect(drawer.getByTestId('close-sidebar-button')).toBeVisible();
    await expect(drawer).not.toHaveAttribute('inert');
  };

  await openDrawer();
  const switcher = drawer.getByTestId('panel-switcher-button');
  await switcher.click();
  await page.getByRole('menuitemcheckbox', { name: OTHER_PANEL }).click();
  await expect(switcher).toContainText(OTHER_PANEL);

  await drawer.getByRole('link', { name: 'New chat' }).click();
  await expect(drawer).toHaveAttribute('inert', '');
  await expect(page).toHaveURL(/\/c\/new$/);

  await openDrawer();
  return switcher;
}

test.describe('new chat panel preference, desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('new chat from another panel returns the desktop sidebar to the chat list @scenario:desktop-new-chat-returns-to-chat-list', async ({
    page,
  }) => {
    const { chats, other } = await desktopNewChat(page, true);
    await expect(chats).toHaveAttribute('aria-pressed', 'true');
    await expect(other).toHaveAttribute('aria-pressed', 'false');
  });

  test('with the preference off the desktop sidebar keeps its panel @scenario:desktop-new-chat-keeps-panel-when-off', async ({
    page,
  }) => {
    const { chats, other } = await desktopNewChat(page, false);
    await expect(other).toHaveAttribute('aria-pressed', 'true');
    await expect(chats).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('new chat panel preference, mobile drawer', () => {
  /** Loaded at phone width rather than resized into it (berry-13/LibreChat#205). */
  test.use({ viewport: { width: 390, height: 844 } });

  test('new chat from another panel returns the drawer to the chat list @scenario:mobile-new-chat-returns-to-chat-list', async ({
    page,
  }) => {
    const switcher = await mobileNewChat(page, true);
    await expect(switcher).toContainText('Chat History');
  });

  test('with the preference off the drawer keeps its panel @scenario:mobile-new-chat-keeps-panel-when-off', async ({
    page,
  }) => {
    const switcher = await mobileNewChat(page, false);
    await expect(switcher).toContainText(OTHER_PANEL);
  });
});
