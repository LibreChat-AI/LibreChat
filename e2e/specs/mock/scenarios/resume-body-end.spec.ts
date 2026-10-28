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

test.describe('resume stream body end', () => {
  test('reattaches and completes when the resume body ends before the terminal frame @scenario:resume-stream-reattaches-when-body-ends-before-final', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `body-end-${Date.now()}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** The first attachment is answered with a complete 2xx body that carries
     *  no terminal frame: what an intermediary closing the connection leaves
     *  the client holding. Every later request passes through untouched, so
     *  the reconnect the transport schedules attaches to the still-running
     *  turn instead of reconciling a finished one. */
    let intercepted = false;
    await page.route(STREAM_ROUTE, async (route) => {
      if (intercepted) {
        await route.continue();
        return;
      }
      intercepted = true;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ': connection cut\n\n',
      });
    });

    /** The initial attachment carries no `resume` cursor; only the reconnect
     *  the dropped body triggers does, so this waiter sees the recovery and
     *  not the connection that was cut. */
    const reattached = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        STREAM_ROUTE.test(new URL(response.url()).pathname) &&
        response.url().includes('resume=true'),
      { timeout: 30_000 },
    );

    const response = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();

    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
      timeout: 30_000,
    });

    const resumeResponse = await reattached;
    expect(resumeResponse.status()).toBe(200);

    const assistantMessage = messagesView(page).locator('.message-render').last();
    await expect(assistantMessage).toContainText(SLOW_REPLY_LAST_CHUNK, {
      timeout: 90_000,
    });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
  });
});
