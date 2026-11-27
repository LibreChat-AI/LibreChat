import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import {
  fetchJson,
  thinkText,
  sendMessage,
  messagesView,
  NEW_CHAT_PATH,
  isAgentsStream,
  MOCK_ENDPOINTS,
  getAccessToken,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { deleteConversations, deleteMessagesByConversation } from '../db';

/** A Gemini call that ends at its output budget (`finishReason: MAX_TOKENS`), issue #18649. The
 *  fake model reports Gemini's raw finish reason the way the Google stream adapter does. */

const NOTICE =
  'The model used its entire output budget on reasoning before answering. Lower the thinking level or increase Max Output Tokens and try again.';
const createdConversationIds: string[] = [];

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('showThinking', 'true'));
});

test.afterAll(async () => {
  await deleteMessagesByConversation(createdConversationIds);
  await deleteConversations(createdConversationIds);
});

const conversationIdOf = (page: Page) => new URL(page.url()).pathname.split('/c/')[1] ?? '';

async function persistedReply(page: Page, conversationId: string): Promise<TMessage | undefined> {
  const token = await getAccessToken(page);
  const messages = await fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
  );
  return messages.find((message) => message.isCreatedByUser === false);
}

async function startChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

test.describe('Gemini output budget', () => {
  test('a reply spent entirely on reasoning keeps the reasoning and explains what to change @scenario:gemini-reasoning-only-reply-shows-output-budget-notice', async ({
    page,
  }) => {
    const label = `budget-${randomUUID().slice(0, 8)}`;
    await startChat(page);
    const response = await sendMessage(page, `E2E_OUTPUT_BUDGET:${label}`);
    expect(response.ok()).toBeTruthy();

    const view = messagesView(page);
    await expect(view.getByText(NOTICE)).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText(thinkText(label))).toBeVisible();

    const conversationId = conversationIdOf(page);
    createdConversationIds.push(conversationId);
    await expect
      .poll(async () => {
        const content = (await persistedReply(page, conversationId))?.content ?? [];
        return content[content.length - 1];
      })
      .toEqual({ type: 'error', error: JSON.stringify({ type: 'output_budget_exhausted' }) });

    await page.reload();
    await expect(view.getByText(NOTICE)).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText(thinkText(label))).toBeVisible();
    await view.getByText(NOTICE).hover();
    await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
  });

  test('a reply cut off mid-answer keeps its text and offers Continue after a reload @scenario:gemini-cut-off-reply-offers-continue', async ({
    page,
  }) => {
    const label = `budget-partial-${randomUUID().slice(0, 8)}`;
    await startChat(page);
    const response = await sendMessageAndWaitForCompletion(
      page,
      `E2E_OUTPUT_BUDGET_PARTIAL:${label}`,
    );
    expect(response.ok()).toBeTruthy();

    const conversationId = conversationIdOf(page);
    createdConversationIds.push(conversationId);
    expect((await persistedReply(page, conversationId))?.finish_reason).toBe('length');

    await page.reload();
    const answer = messagesView(page).getByText(`E2E partial answer ${label}`);
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(messagesView(page).getByText(NOTICE)).toHaveCount(0);
    await answer.hover();
    await expect(page.getByTestId('continue-generation-button')).toBeVisible();
    await expect(page.getByTestId('continue-generation-button')).toHaveAccessibleName('Continue');
  });

  test('continuing a cut-off reply to the end stops offering Continue @scenario:gemini-continued-reply-stops-offering-continue', async ({
    page,
  }) => {
    const label = `budget-continue-${randomUUID().slice(0, 8)}`;
    await startChat(page);
    await sendMessageAndWaitForCompletion(page, `E2E_OUTPUT_BUDGET_PARTIAL:${label}`);
    const conversationId = conversationIdOf(page);
    createdConversationIds.push(conversationId);

    const answer = messagesView(page).getByText(`E2E partial answer ${label}`);
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await answer.hover();
    const [stream] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30_000 }),
      page.getByTestId('continue-generation-button').click(),
    ]);
    expect(stream.ok()).toBeTruthy();
    const rest = `E2E rest of the answer ${label}`;
    await expect(messagesView(page).getByText(rest)).toBeVisible({ timeout: 30_000 });

    /** The continuation is the conversation's latest reply now, persisted as finished. */
    await expect
      .poll(
        async () => {
          const token = await getAccessToken(page);
          const messages = await fetchJson<TMessage[]>(
            page,
            `/api/messages/${encodeURIComponent(conversationId)}`,
            token,
          );
          return messages.find((message) =>
            message.content?.some((part) => part?.type === 'text' && part.text === rest),
          )?.finish_reason;
        },
        { timeout: 30_000 },
      )
      .toBe('stop');

    await page.reload();
    const finished = messagesView(page).getByText(rest);
    await expect(finished).toBeVisible({ timeout: 30_000 });
    await finished.hover();
    await expect(page.getByTestId('regenerate-generation-button')).toBeVisible();
    await expect(page.getByTestId('continue-generation-button')).toHaveCount(0);
  });
});
