import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/** The fake model's resume reply: 240 chunks 60ms apart, about 14 seconds. */
const LONG_REPLY_MARKER = 'E2E_RESUME_ICON_REPLY';
const LONG_REPLY_LAST_CHUNK = 'chunk-239';

/**
 * Whether a chat can reattach to its run depends on the conversation its pane shows, which the
 * host supplies through the chat settings. Leaving through the router keeps the app mounted, so
 * the pane moves to another conversation and back without a reload.
 */
test.describe('pane conversation on return', () => {
  test('returning to a running chat through the router shows the reply finish @scenario:a-chat-left-mid-reply-finishes-on-return', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `pane-resume-${Date.now()}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const setup = await sendMessage(page, replyPrompt(`${label}-setup`));
    expect(setup.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(`${label}-setup`))).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15_000 });
    const conversationPath = new URL(page.url()).pathname;

    const response = await sendMessage(page, `${LONG_REPLY_MARKER}:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });

    await page.evaluate((path) => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, NEW_CHAT_PATH);
    await expect(page).toHaveURL(/\/c\/new$/);
    await expect(messagesView(page).getByText('chunk-010')).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${conversationPath}(\\?.*)?$`));
    const assistantMessage = messagesView(page).locator('.message-render').last();
    await expect(assistantMessage).toContainText(LONG_REPLY_LAST_CHUNK, { timeout: 90_000 });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
  });
});
