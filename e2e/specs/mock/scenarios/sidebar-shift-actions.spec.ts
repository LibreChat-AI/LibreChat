import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SeedConvo } from '../db';
import { clearUserConversations, seedConversations } from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * Holding shift swaps the open conversation's menu for archive and delete. Only that row
 * answers to the key, and the key is tracked once for the page: a listener in every row ran for
 * each of them on every key press, and holding shift rendered the whole list.
 */

const CHATS = 12;
const userEmail = getE2EUser().email;

/** Listeners of one type on `window`, read from the browser rather than from the app. */
async function windowListeners(page: Page, type: string): Promise<number> {
  const session = await page.context().newCDPSession(page);
  const { result } = await session.send('Runtime.evaluate', { expression: 'window' });
  const { listeners } = await session.send('DOMDebugger.getEventListeners', {
    objectId: result.objectId ?? '',
  });
  await session.detach();
  return listeners.filter((listener) => listener.type === type).length;
}

test.describe('shift over the sidebar', () => {
  let chats: SeedConvo[];

  test.beforeEach(async ({ page }) => {
    await clearUserConversations(userEmail);
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    chats = Array.from({ length: CHATS }, (_, index) => ({
      conversationId: randomUUID(),
      title: `Shift chat ${String(index).padStart(2, '0')}`,
      updatedAt: new Date(noon.getTime() - index * 1000),
    }));
    await seedConversations(userEmail, chats);
    await page.goto(`/c/${chats[0].conversationId}`);
  });

  test.afterEach(async () => {
    await clearUserConversations(userEmail);
  });

  test('holding shift offers archive and delete on the open conversation alone @scenario:shift-offers-quick-actions-on-the-open-conversation', async ({
    page,
  }) => {
    const history = page.getByRole('region', { name: 'Chat History' });
    const rows = history.getByTestId('convo-item');
    await expect(rows).toHaveCount(CHATS);
    const open = rows.filter({ hasText: chats[0].title });
    await expect(open.getByRole('button', { name: 'Archive' })).toHaveCount(0);

    await page.keyboard.down('Shift');
    await expect(open.getByRole('button', { name: 'Archive' })).toBeVisible();
    await expect(open.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(history.getByRole('button', { name: 'Archive' })).toHaveCount(1);

    await page.keyboard.up('Shift');
    await expect(history.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  });

  test('opening another conversation moves the quick actions to its row @scenario:shift-quick-actions-follow-the-open-conversation', async ({
    page,
  }) => {
    const history = page.getByRole('region', { name: 'Chat History' });
    const rows = history.getByTestId('convo-item');
    await expect(rows).toHaveCount(CHATS);
    const next = rows.filter({ hasText: chats[3].title });

    await next.click();
    await expect(page).toHaveURL(new RegExp(`/c/${chats[3].conversationId}`));
    await page.keyboard.down('Shift');

    await expect(next.getByRole('button', { name: 'Archive' })).toBeVisible();
    await expect(history.getByRole('button', { name: 'Archive' })).toHaveCount(1);
    await page.keyboard.up('Shift');
  });

  test('opening another conversation with shift still held offers them there at once @scenario:shift-held-across-a-conversation-switch', async ({
    page,
  }) => {
    const history = page.getByRole('region', { name: 'Chat History' });
    const rows = history.getByTestId('convo-item');
    await expect(rows).toHaveCount(CHATS);
    const next = rows.filter({ hasText: chats[5].title });

    /** The key goes down once and is not pressed again: the next row never saw it go down. */
    await page.keyboard.down('Shift');
    await next.click();
    await expect(page).toHaveURL(new RegExp(`/c/${chats[5].conversationId}`));

    await expect(next.getByRole('button', { name: 'Archive' })).toBeVisible();
    await expect(history.getByRole('button', { name: 'Archive' })).toHaveCount(1);

    await page.keyboard.up('Shift');
    await expect(history.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  });

  test('shift held in a new chat, with no open row, is known to the row opened next @scenario:shift-held-before-any-conversation-is-open', async ({
    page,
  }) => {
    await page.goto('/c/new');
    const history = page.getByRole('region', { name: 'Chat History' });
    const rows = history.getByTestId('convo-item');
    await expect(rows).toHaveCount(CHATS);
    const next = rows.filter({ hasText: chats[2].title });

    /** No row answers to the key here, so none reads it: it has to be tracked all the same. */
    await page.keyboard.down('Shift');
    await expect(history.getByRole('button', { name: 'Archive' })).toHaveCount(0);
    await next.click();
    await expect(page).toHaveURL(new RegExp(`/c/${chats[2].conversationId}`));

    await expect(next.getByRole('button', { name: 'Archive' })).toBeVisible();
    await page.keyboard.up('Shift');
    await expect(history.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  });

  test('the list listens for the key once, however many conversations it holds @scenario:sidebar-listens-for-shift-once', async ({
    page,
  }) => {
    const history = page.getByRole('region', { name: 'Chat History' });
    await expect(history.getByTestId('convo-item')).toHaveCount(CHATS);

    expect(await windowListeners(page, 'keyup')).toBe(1);
  });
});
