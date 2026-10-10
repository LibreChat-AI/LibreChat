import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  isAgentsStream,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  sendMessage,
  replyText,
} from '../helpers';

/**
 * Every control here reads its handlers and state from `ChatContext` (or
 * `AddedChatContext` for the second pane), so these are the behaviors the
 * declared chat contract has to keep serving.
 */

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });
const messageRows = (page: Page) => messagesView(page).locator('.message-render');

async function openMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

test.describe('chat context', () => {
  test('streams the reply to a sent message and keeps it after reload @scenario:sent-message-streams-a-reply-that-survives-reload', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const label = uniqueLabel('send');
    await openMockChat(page);

    const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(response.ok()).toBeTruthy();
    await expect(messageRows(page).last().locator('.message-content')).toHaveText(
      replyText(label),
      { timeout: 30_000 },
    );
    await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });

    await page.reload({ timeout: 10_000 });
    await expect(messageRows(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(messageRows(page).last().locator('.message-content')).toHaveText(
      replyText(label),
      { timeout: 30_000 },
    );
  });

  test('regenerating the latest response adds a sibling the user can page between @scenario:regenerate-adds-a-sibling-response', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('regen');
    await openMockChat(page);

    const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(response.ok()).toBeTruthy();
    const assistant = messageRows(page).last();
    await expect(assistant.locator('.message-content')).toHaveText(replyText(label), {
      timeout: 30_000,
    });

    await assistant.hover();
    const [regenerated] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30_000 }),
      assistant.getByRole('button', { name: 'Regenerate', exact: true }).last().click(),
    ]);
    expect(regenerated.ok()).toBeTruthy();

    await expect(page.getByText('2 / 2')).toBeVisible({ timeout: 30_000 });
    await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });
    await expect(messageRows(page).last().locator('.message-content')).toHaveText(
      replyText(label),
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Previous sibling message' }).click();
    await expect(page.getByText('1 / 2')).toBeVisible();
    await expect(messageRows(page).last().locator('.message-content')).toHaveText(replyText(label));
  });

  test('stopping a streaming reply keeps the partial response after reload @scenario:stop-keeps-the-partial-response', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('stop');
    await openMockChat(page);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });

    const [abort] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/api/agents/chat/abort'),
        { timeout: 30_000 },
      ),
      stopButton(page).click(),
    ]);
    expect(abort.ok()).toBeTruthy();
    await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });

    const partial = messageRows(page).last().locator('.message-content');
    await expect(partial).toContainText(`E2E slow reply ${label}`);
    await expect(partial).not.toContainText('chunk-159');

    await page.reload({ timeout: 10_000 });
    await expect(messageRows(page).last().locator('.message-content')).toContainText(
      `E2E slow reply ${label}`,
      { timeout: 30_000 },
    );
    await expect(messageRows(page).last().locator('.message-content')).not.toContainText(
      'chunk-159',
    );
  });

  test('a second conversation pane streams its own reply to the same message @scenario:added-conversation-streams-alongside-the-main-reply', async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width < 768, 'the multi-conversation control is hidden below md');
    test.setTimeout(90_000);
    const label = uniqueLabel('added');
    await openMockChat(page);

    await page.getByTestId('add-multi-convo-button').click();
    const run = await sendMessage(page, replyPrompt(label));
    expect(run.ok()).toBeTruthy();

    await expect(messagesView(page).getByText(replyText(label), { exact: true })).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });
  });
});
