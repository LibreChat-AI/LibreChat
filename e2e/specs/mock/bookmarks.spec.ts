import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  conversationRow,
  selectMockEndpoint,
  getAccessToken,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  sendMessage,
  fetchJson,
} from './helpers';

import { getE2EUser } from '../../setup/user';
import { deleteConversations, seedConversations, withMongo } from './db';

type TagCount = { tag: string; count: number };

const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

/** The header bookmark menu (the nav filter button shares the `bookmark-menu` testid). */
const headerBookmarkButton = (page: Page) => page.locator('#bookmark-menu-button');

/** Start a mock chat and send a message so the conversation persists at `/c/:id`. */
async function startBookmarkableChat(page: Page): Promise<void> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, 'hello bookmarks');
  expect(response.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
  await expect(headerBookmarkButton(page)).toBeVisible({ timeout: 15000 });
}

/** Create a brand-new bookmark and attach it to the active conversation (count -> 1). */
async function createBookmarkForActiveChat(page: Page, tag: string): Promise<void> {
  await headerBookmarkButton(page).click();
  await page.getByRole('menuitem', { name: 'New Bookmark' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Title' }).fill(tag);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tags',
      { timeout: 15000 },
    ),
    dialog.getByRole('button', { name: 'Save' }).click(),
  ]);
  expect(response.ok()).toBeTruthy();
  await expect(dialog).toBeHidden();
  await page.keyboard.press('Escape');
}

/** Attach an already-existing bookmark to the active conversation (count += 1). */
async function addExistingBookmarkToActiveChat(page: Page, tag: string): Promise<void> {
  await headerBookmarkButton(page).click();
  // Existing-tag rows render as `menuitemcheckbox` (they carry aria-checked).
  const tagItem = page.getByRole('menuitemcheckbox', { name: tag, exact: true });
  await expect(tagItem).toBeVisible({ timeout: 10000 });
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' && new URL(r.url()).pathname.startsWith('/api/tags/convo/'),
      { timeout: 15000 },
    ),
    tagItem.click(),
  ]);
  expect(response.ok()).toBeTruthy();
  await page.keyboard.press('Escape');
}

/** Read the persisted bookmark count from the server (0 when the tag is absent). */
async function getTagCount(page: Page, tag: string): Promise<number> {
  const token = await getAccessToken(page);
  const tags = await fetchJson<TagCount[]>(page, '/api/tags', token);
  return tags.find((t) => t.tag === tag)?.count ?? 0;
}

async function renameConversation(page: Page, conversation: Locator, title: string): Promise<void> {
  await conversation.hover();
  await conversation.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const titleInput = conversation.getByRole('textbox', { name: 'New Conversation Title' });
  await expect(titleInput).toBeVisible();
  await titleInput.fill(title);
  await conversation.getByRole('button', { name: 'Save' }).click();
  await expect(conversation).toContainText(title);
}

async function deleteConversation(page: Page, conversation: Locator): Promise<void> {
  await conversation.hover();
  await conversation.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();

  const dialog = page.getByRole('dialog', { name: 'Delete chat?' });
  await expect(dialog).toBeVisible();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && r.url().includes('/api/convos'),
      { timeout: 30000 },
    ),
    dialog.getByRole('button', { name: 'Delete' }).click(),
  ]);
  expect(response.ok()).toBeTruthy();
}

test.describe('bookmark counts', () => {
  test.describe.configure({ timeout: 120_000 });
  let unreadId: string;

  test.beforeEach(async () => {
    unreadId = randomUUID();
    const previous = new Date(Date.now() - 86_400_000);
    await seedConversations(getE2EUser().email, [
      {
        conversationId: unreadId,
        title: 'Finished sidebar decoy',
        updatedAt: previous,
      },
    ]);
    await withMongo(async (db) => {
      await db.collection('conversations').updateOne(
        { conversationId: unreadId },
        {
          $set: {
            lastResponseAt: previous,
            lastSeenAt: new Date(previous.getTime() - 1000),
            isMarkedUnread: false,
          },
        },
      );
    });
  });

  test.afterEach(async () => {
    await deleteConversations([unreadId]);
  });

  test('drops a bookmark count to zero when its only conversation is deleted', async ({ page }) => {
    const tag = uniqueName('E2E Bookmark');

    await startBookmarkableChat(page);
    await createBookmarkForActiveChat(page, tag);
    expect(await getTagCount(page, tag)).toBe(1);
    await expect(page.getByTestId('convo-item').first()).not.toHaveAttribute(
      'data-conversation-id',
      new URL(page.url()).pathname.split('/c/')[1],
    );

    await deleteConversation(page, conversationRow(page));

    await expect.poll(() => getTagCount(page, tag), { timeout: 15000 }).toBe(0);
  });

  test('keeps a shared bookmark at one when another conversation still uses it', async ({
    page,
  }) => {
    const tag = uniqueName('E2E Shared');

    // Conversation A: create the bookmark (count -> 1).
    await startBookmarkableChat(page);
    await createBookmarkForActiveChat(page, tag);
    const conversationAUrl = page.url();
    const titleA = uniqueName('Bookmark A');
    await renameConversation(page, conversationRow(page), titleA);
    expect(await getTagCount(page, tag)).toBe(1);

    // Conversation B: attach the same bookmark (count -> 2).
    await startBookmarkableChat(page);
    await addExistingBookmarkToActiveChat(page, tag);
    const titleB = uniqueName('Bookmark B');
    await renameConversation(page, conversationRow(page), titleB);
    expect(await getTagCount(page, tag)).toBe(2);

    // Deleting A leaves the count at 1 because B still carries the bookmark.
    const conversationA = conversationRow(page, conversationAUrl);
    await deleteConversation(page, conversationA);

    await expect.poll(() => getTagCount(page, tag), { timeout: 15000 }).toBe(1);
    await expect(page.getByTestId('convo-item').filter({ hasText: titleB })).toBeVisible();
  });
});
