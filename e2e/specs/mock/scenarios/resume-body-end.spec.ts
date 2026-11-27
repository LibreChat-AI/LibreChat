import { expect, test } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  sendMessage,
  messagesView,
  NEW_CHAT_PATH,
  conversationRow,
  MOCK_ENDPOINTS,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
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

  test('waits longer before each attempt while a gateway answers for the stream, then settles the reply from what the server kept @scenario:resume-stream-backs-off-while-a-gateway-answers', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const label = `gateway-${Date.now()}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const earlier = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(earlier.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible();

    /** The server takes the next turn and runs it; every request for its stream is answered by
     *  a gateway instead, with headers and a body of its own, as one in front of a server that
     *  is restarting does. */
    const asked: number[] = [];
    await page.route(STREAM_ROUTE, async (route) => {
      asked.push(Date.now());
      await route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' });
    });

    const response = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
      timeout: 30_000,
    });

    /** After the last retry the server is asked what became of the run. It ended meanwhile, so
     *  the reply is read from what was stored and the chat stops waiting for a stream. */
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 90_000,
    });
    const assistantMessage = messagesView(page).locator('.message-render').last();
    await expect(assistantMessage).toContainText(SLOW_REPLY_LAST_CHUNK);

    /** The first attempt and five retries, each after twice the wait of the one before: an
     *  answer that is not the stream is a failed attempt, not a connection made and lost. */
    expect(asked).toHaveLength(6);
    const waits = asked.slice(1).map((at, index) => at - asked[index]);
    expect(waits[2]).toBeGreaterThan(3_000);
    expect(waits[3]).toBeGreaterThan(6_500);
    expect(waits[4]).toBeGreaterThan(13_000);
  });
  test('reads back the first reply of a new conversation whose stream could never be reached @scenario:resume-new-conversation-is-read-back-after-the-last-retry', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = `unreached-${Date.now()}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** The server takes the first turn of a new conversation and runs it to its end; no request
     *  for its stream gets through, so the page never hears that the conversation was created. */
    let reachable = false;
    await page.route(STREAM_ROUTE, async (route) => {
      if (reachable) {
        await route.continue();
        return;
      }
      await route.abort('connectionfailed');
    });

    const response = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
      timeout: 30_000,
    });

    /** After the last retry the run is found over, and what it left is read from the server:
     *  the reply, in a conversation that is the reader's to go on with. */
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 90_000,
    });
    const turns = messagesView(page).locator('.message-render');
    await expect(turns).toHaveCount(2);
    await expect(turns.nth(1)).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 15_000 });
    await expect(conversationRow(page, page.url())).toBeVisible({ timeout: 15_000 });

    reachable = true;
    const next = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(next.ok()).toBeTruthy();
    await expect(turns).toHaveCount(4);
    await expect(turns.nth(3)).toContainText(replyText(label));
  });
});
