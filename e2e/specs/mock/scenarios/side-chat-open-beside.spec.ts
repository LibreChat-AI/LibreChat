import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  conversationRow,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openChatHistory } from './sidebar';

/**
 * A conversation opened beside the one on screen, from its row in the sidebar: the reader keeps
 * the chat they are in and takes a turn in the other.
 */
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function startChat(page: Page, label: string): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible();
  return page.url();
}

test('an earlier conversation opens beside the one on screen and takes a turn there @scenario:side-chat-opens-conversation-beside', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const earlier = uniqueLabel('earlier');
  const current = uniqueLabel('current');
  const followUp = uniqueLabel('beside');

  const earlierUrl = await startChat(page, earlier);
  const currentUrl = await startChat(page, current);
  const currentPath = new URL(currentUrl).pathname;
  expect(currentPath).not.toBe(new URL(earlierUrl).pathname);

  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();

  /** The earlier conversation is beside the current one, which has not moved. */
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toBeVisible({ timeout: 30_000 });
  await expect(sideChat).toContainText(replyText(earlier));
  await expect(sideChat).not.toContainText(replyText(current));
  expect(new URL(page.url()).pathname).toBe(currentPath);
  await expect(messagesView(page).getByText(replyText(current))).toBeVisible();

  /** A turn from its composer runs in that conversation, not the one on screen. */
  const composer = sideChat.getByRole('textbox', { name: 'Message input' });
  await composer.fill(replyPrompt(followUp));
  const [start] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/api\/agents\/chat\/[^/]+$/.test(new URL(request.url()).pathname) &&
        !request.url().endsWith('/abort'),
    ),
    composer.press('Enter'),
  ]);
  const posted = start.postDataJSON() as { conversationId?: string };
  expect(earlierUrl).toContain(posted.conversationId ?? 'none');
  await expect(sideChat).toContainText(replyText(followUp), { timeout: 30_000 });
  await expect(messagesView(page).getByText(replyText(followUp))).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(currentPath);

  /** The chat on screen cannot be opened beside itself. */
  const currentRow = conversationRow(page, currentUrl);
  await currentRow.hover();
  await currentRow.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open beside chat' })).toHaveCount(0);
});
