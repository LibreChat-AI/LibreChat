import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/** Last chunk streamed by the fake model's slow replies (160 chunks, 0-indexed). */
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';

const STREAM_ROUTE = /\/api\/agents\/chat\/stream\//;

test.describe('reload during a reply', () => {
  test('reattaches to the running reply after a reload and finishes it @scenario:a-reload-mid-reply-reattaches-and-finishes-it', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `reload-resume-${Date.now()}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15_000 });

    /** Only the page that loads after the reload asks for the stream with a
     *  resume cursor, so this waiter sees the reattachment and not the
     *  connection the reload dropped. */
    const reattached = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'GET' &&
        STREAM_ROUTE.test(new URL(candidate.url()).pathname) &&
        candidate.url().includes('resume=true'),
      { timeout: 30_000 },
    );

    await page.reload();

    expect((await reattached).status()).toBe(200);
    const assistantMessage = messagesView(page).locator('.message-render').last();
    await expect(assistantMessage).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 90_000 });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
  });
});
