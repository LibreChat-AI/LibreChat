import { expect, test } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  sendMessage,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  conversationRow,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openSidebar } from './sidebar';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The stream event handlers write the route, the sidebar lists, the message cache and the
 *  conversation title as a turn opens and settles; these follow each write on the running app. */
test.describe('stream event handlers', () => {
  test('a new chat moves to its saved route and lists itself in the sidebar @scenario:new-chat-send-settles-route-and-sidebar', async ({
    page,
  }) => {
    const label = uniqueLabel('events-send');
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/i);

    await openSidebar(page);
    await expect(conversationRow(page)).toBeVisible();

    await page.reload();
    await expect(messagesView(page).getByText(replyPrompt(label))).toBeVisible();
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible();
  });

  test('stopping a reply keeps what streamed and re-enables sending @scenario:stopped-reply-keeps-streamed-text', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('events-stop');
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Stop generating' }).click();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/i);

    await page.reload();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 20_000 });
    await expect(messagesView(page).getByText('chunk-159')).toHaveCount(0);
  });

  test('a generated title names the new conversation in the sidebar @scenario:generated-title-names-new-conversation', async ({
    page,
    request,
  }) => {
    test.skip(process.env.E2E_TITLE_CONVO !== 'true', 'Requires the title-enabled mock profile');
    test.setTimeout(60_000);
    const label = uniqueLabel('events-title');
    const title = `Generated ${label}`;
    const fixture = `http://127.0.0.1:${process.env.E2E_LABEL_PORT ?? '8889'}`;
    await request.post(`${fixture}/__e2e/reset`);
    await request.post(`${fixture}/__e2e/behavior`, { data: { label: title } });
    try {
      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, {
        label: 'Mock Titles immediate',
        model: 'mock-titles-immediate',
      });
      const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
      expect(response.ok()).toBeTruthy();
      await expect(messagesView(page).getByText(replyText(label))).toBeVisible();

      await openSidebar(page);
      const row = conversationRow(page);
      await expect(row).toContainText(title, { timeout: 30_000 });

      await page.reload();
      await openSidebar(page);
      await expect(conversationRow(page)).toContainText(title);
    } finally {
      await request.post(`${fixture}/__e2e/reset`, { timeout: 2000 }).catch(() => undefined);
    }
  });
});
