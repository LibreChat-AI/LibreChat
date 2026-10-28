import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { messagesView } from '../helpers';

/**
 * The text-like parts render from `@librechat/chat/components` and draw markdown through the
 * app's host slot. Each scenario loads a stored conversation and checks what the reader sees.
 */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type StoredMessage = {
  isCreatedByUser: boolean;
  text: string;
  content?: Array<Record<string, unknown>>;
};

/** Serves a conversation whose messages chain in the order given. */
async function openStoredConversation(page: Page, messages: StoredMessage[]): Promise<void> {
  const conversationId = unique('e2e-text-parts');
  const now = new Date(0).toISOString();
  const stored = messages.map((message, index) => ({
    messageId: `${conversationId}-${index}`,
    conversationId,
    parentMessageId: index === 0 ? NO_PARENT : `${conversationId}-${index - 1}`,
    sender: message.isCreatedByUser ? 'User' : 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
    ...message,
  }));
  const conversation = {
    conversationId,
    title: 'Text parts',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const convoIdRe = escapeRe(conversationId);
  await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stored) }),
  );
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
}

test.describe('text-like message parts', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll();
  });

  test('assistant text renders as markdown through the host renderer @scenario:assistant-text-renders-markdown', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const word = unique('strong');
    const source = `**${word}** and \`inline-code\``;
    await openStoredConversation(page, [
      { isCreatedByUser: true, text: 'question' },
      { isCreatedByUser: false, text: source, content: [{ type: 'text', text: source }] },
    ]);
    const view = messagesView(page);
    const text = view.locator('[data-message-text]').filter({ hasText: word });
    await expect(text.locator('strong', { hasText: word })).toBeVisible({ timeout: 15000 });
    await expect(text.locator('code', { hasText: 'inline-code' })).toBeVisible();
  });

  test('a stored summary opens to its text from its disclosure @scenario:summary-part-expands', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const summary = unique('summary-body');
    await openStoredConversation(page, [
      { isCreatedByUser: true, text: 'question' },
      {
        isCreatedByUser: false,
        text: 'after the summary',
        content: [
          { type: 'summary', content: [{ type: 'text', text: summary }], tokenCount: 12 },
          { type: 'text', text: 'after the summary' },
        ],
      },
    ]);
    const view = messagesView(page);
    const disclosure = view.getByRole('button', { name: /Conversation summarized/ }).first();
    await expect(disclosure).toBeVisible({ timeout: 15000 });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(view.getByRole('region', { name: 'Conversation summarized' })).toBeHidden();

    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(view.getByText(summary)).toBeVisible();
    await expect(view.getByText('after the summary', { exact: true })).toBeVisible();
  });

  test('a long user message collapses behind show more @scenario:long-user-text-collapses', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const tail = unique('tail');
    const long = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n${tail}`;
    await openStoredConversation(page, [
      { isCreatedByUser: true, text: long },
      { isCreatedByUser: false, text: 'ok', content: [{ type: 'text', text: 'ok' }] },
    ]);
    const view = messagesView(page);
    const toggle = view.getByRole('button', { name: 'Show more' });
    await expect(toggle).toBeVisible({ timeout: 15000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const regionId = await toggle.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    const region = page.locator(`[id="${regionId}"]`);
    await expect(region).toHaveCSS('overflow-y', 'hidden');
    await expect(region).toContainText(tail);

    await toggle.click();
    const less = view.getByRole('button', { name: 'Show less' });
    await expect(less).toHaveAttribute('aria-expanded', 'true');
    await expect(region).not.toHaveCSS('overflow-y', 'hidden');
  });
});
