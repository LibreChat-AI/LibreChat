import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
} from '../helpers';

type ContractView = {
  messagesKey: string;
  conversationIds: Array<string | null | undefined>;
};

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * No component renders `messagesKey` yet, so the pane's chat contract is read where the app
 * serves it: the `ChatContext` value on the nearest provider above the messages or composer.
 */
async function readChatContract(page: Page): Promise<ContractView | null> {
  return page.evaluate(() => {
    type Fiber = { memoizedProps?: { value?: unknown }; return: Fiber | null };
    type Contract = {
      messagesKey: string;
      getMessages: () => Array<{ conversationId?: string | null }> | undefined;
    };
    const node =
      document.querySelector('[data-testid="screenshot-target"]') ??
      document.querySelector('#prompt-textarea');
    if (!node) {
      return null;
    }
    const fiberKey = Object.keys(node).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey
      ? ((node as unknown as Record<string, Fiber | undefined>)[fiberKey] ?? null)
      : null;
    while (fiber) {
      const value = fiber.memoizedProps?.value as Partial<Contract> | undefined;
      if (value && typeof value === 'object' && 'messagesKey' in value && value.getMessages) {
        return {
          messagesKey: value.messagesKey as string,
          conversationIds: (value.getMessages() ?? []).map((message) => message.conversationId),
        };
      }
      fiber = fiber.return;
    }
    return null;
  });
}

const conversationIdOf = (page: Page) => new URL(page.url()).pathname.replace('/c/', '');

async function startConversation(page: Page, label: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).locator('.message-render').last()).toContainText(
    replyText(label),
    { timeout: 30_000 },
  );
  await expect(page).toHaveURL(/\/c\/(?!new$)[^/]+$/, { timeout: 30_000 });
  return conversationIdOf(page);
}

test.describe('chat contract', () => {
  test('names the conversation its messages are read from as the pane moves between chats @scenario:chat-contract-names-the-messages-key', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const first = await startConversation(page, uniqueLabel('contract-first'));
    await expect.poll(() => readChatContract(page)).toMatchObject({ messagesKey: first });

    const second = await startConversation(page, uniqueLabel('contract-second'));
    expect(second).not.toBe(first);
    await expect.poll(() => readChatContract(page)).toMatchObject({ messagesKey: second });

    await page.goto(`/c/${first}`, { timeout: 10_000 });
    await expect(messagesView(page).locator('.message-render')).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect
      .poll(() => readChatContract(page))
      .toEqual({ messagesKey: first, conversationIds: [first, first] });

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await expect.poll(async () => (await readChatContract(page))?.messagesKey).toBe('new');
  });
});
