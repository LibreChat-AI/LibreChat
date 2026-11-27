import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import { deleteConversations, deleteMessagesByConversation } from '../db';
import {
  fetchJson,
  sendMessage,
  messagesView,
  NEW_CHAT_PATH,
  getAccessToken,
  sendMessageAndWaitForCompletion,
} from '../helpers';

const NEW_CHAT_URL = /\/c\/new(\?|$)/;
const conversationUrl = (conversationId: string) => new RegExp(`/c/${conversationId}(\\?|$)`);

async function startNewChat(page: Page) {
  await page
    .getByRole('link', { name: 'New chat', exact: true })
    .or(page.getByRole('button', { name: 'New chat', exact: true }))
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(NEW_CHAT_URL);
}

async function admittedConversationId(response: Response): Promise<string> {
  const { conversationId } = (await response.json()) as { conversationId?: string };
  if (!conversationId) {
    throw new Error('Generation admission did not name a conversation');
  }
  return conversationId;
}

async function readMessages(page: Page, conversationId: string): Promise<TMessage[]> {
  const token = await getAccessToken(page);
  return fetchJson<TMessage[]>(page, `/api/messages/${encodeURIComponent(conversationId)}`, token);
}

async function userTexts(page: Page, conversationId: string): Promise<string[]> {
  const messages = await readMessages(page, conversationId);
  return messages.filter((message) => message.isCreatedByUser).map((message) => message.text);
}

/** A slow reply's user turn, and its reply persisted as finished. */
async function waitForFinishedReply(page: Page, conversationId: string) {
  await expect
    .poll(
      async () =>
        (await readMessages(page, conversationId)).some(
          (message) => !message.isCreatedByUser && message.unfinished === false,
        ),
      { timeout: 30000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
}

test.describe('new chat entries in browser history', () => {
  test('Back after a reply opens a new chat that sends to a new conversation @scenario:new-chat-history-back-after-reply', async ({
    page,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const first = `First history chat ${suffix}`;
    const second = `Second history chat ${suffix}`;
    const created: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 20000 });
      const firstId = await admittedConversationId(
        await sendMessageAndWaitForCompletion(page, first),
      );
      created.push(firstId);
      await expect(page).toHaveURL(conversationUrl(firstId));
      await expect(messagesView(page).getByText(first)).toBeVisible();

      await page.goBack();
      await expect(page).toHaveURL(NEW_CHAT_URL);
      await expect(messagesView(page).getByText(first)).toHaveCount(0);

      const secondId = await admittedConversationId(await sendMessage(page, second));
      created.push(secondId);
      expect(secondId).not.toBe(firstId);
      await expect(page).toHaveURL(conversationUrl(secondId));
      await expect(messagesView(page).getByText(second)).toBeVisible();
      expect(await userTexts(page, firstId)).toEqual([first]);
    } finally {
      await deleteMessagesByConversation(created);
      await deleteConversations(created);
    }
  });

  test('Back during a reply opens a new chat that sends to a new conversation @scenario:new-chat-history-back-during-reply', async ({
    page,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const first = `E2E_SLOW_REPLY:back-${suffix}`;
    const second = `Second back chat ${suffix}`;
    const created: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 20000 });
      const firstId = await admittedConversationId(await sendMessage(page, first));
      created.push(firstId);
      await expect(page).toHaveURL(conversationUrl(firstId));

      await page.goBack();
      await expect(page).toHaveURL(NEW_CHAT_URL);
      await expect(messagesView(page).getByText(first)).toHaveCount(0);

      const secondId = await admittedConversationId(await sendMessage(page, second));
      created.push(secondId);
      expect(secondId).not.toBe(firstId);

      await waitForFinishedReply(page, firstId);
      await expect(page).toHaveURL(conversationUrl(secondId));
      await expect(messagesView(page).getByText(second)).toBeVisible();
      await expect(messagesView(page).getByText(first)).toHaveCount(0);
      expect(await userTexts(page, firstId)).toEqual([first]);
    } finally {
      await deleteMessagesByConversation(created);
      await deleteConversations(created);
    }
  });

  test('a new chat reached by Back during a reply stays new when the reply finishes @scenario:new-chat-history-back-during-reply-stays-new', async ({
    page,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const first = `E2E_SLOW_REPLY:idle-${suffix}`;
    const created: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 20000 });
      const firstId = await admittedConversationId(await sendMessage(page, first));
      created.push(firstId);
      await expect(page).toHaveURL(conversationUrl(firstId));

      await page.goBack();
      await expect(page).toHaveURL(NEW_CHAT_URL);

      await waitForFinishedReply(page, firstId);
      await expect(page).toHaveURL(NEW_CHAT_URL);
      await expect(messagesView(page).getByText(first)).toHaveCount(0);
    } finally {
      await deleteMessagesByConversation(created);
      await deleteConversations(created);
    }
  });

  test('New chat during a reply sends to a new conversation @scenario:new-chat-history-new-chat-during-reply', async ({
    page,
  }) => {
    const suffix = randomUUID().slice(0, 8);
    const first = `E2E_SLOW_REPLY:new-${suffix}`;
    const second = `Second new chat ${suffix}`;
    const created: string[] = [];
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 20000 });
      const firstId = await admittedConversationId(await sendMessage(page, first));
      created.push(firstId);
      await expect(page).toHaveURL(conversationUrl(firstId));

      await startNewChat(page);
      const secondId = await admittedConversationId(await sendMessage(page, second));
      created.push(secondId);
      expect(secondId).not.toBe(firstId);

      await waitForFinishedReply(page, firstId);
      expect(await userTexts(page, firstId)).toEqual([first]);
    } finally {
      await deleteMessagesByConversation(created);
      await deleteConversations(created);
    }
  });
});
