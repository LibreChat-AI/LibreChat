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

/** The fake model's resume reply: 240 chunks 60ms apart, about 14 seconds, so a
 *  reload lands well inside the run. */
const LONG_REPLY_MARKER = 'E2E_RESUME_ICON_REPLY';
const LONG_REPLY_LAST_CHUNK = 'chunk-239';

const STREAM_ROUTE = /\/api\/agents\/chat\/stream\//;
const TERMINAL_FRAME = /"final"\s*:\s*true/;

test.describe('reload during a reply', () => {
  test('reattaches to the running reply after a reload and finishes it @scenario:a-reload-mid-reply-reattaches-and-finishes-it', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `reload-resume-${Date.now()}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** A new chat only takes its `/c/:id` route when its first reply ends, so
     *  the long reply runs in a conversation that is already persisted: the
     *  reload then lands on that conversation while the reply is streaming. */
    const setup = await sendMessage(page, replyPrompt(`${label}-setup`));
    expect(setup.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(`${label}-setup`))).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15_000 });

    const response = await sendMessage(page, `${LONG_REPLY_MARKER}:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });

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

    const resumed = await reattached;
    expect(resumed.status()).toBe(200);
    const assistantMessage = messagesView(page).locator('.message-render').last();
    await expect(assistantMessage).toContainText(LONG_REPLY_LAST_CHUNK, { timeout: 90_000 });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();

    /** The terminal frame carries the whole persisted answer, and a finished job
     *  answers a resume with its snapshot plus that frame, so the page alone
     *  proves neither a replay nor a live attachment. The resumed stream must
     *  replay the opening chunks in a snapshot taken before the run ended, then
     *  carry live events ahead of its terminal frame. */
    const events = (await resumed.text()).split(/\n\n+/).filter((event) => event.includes('data:'));
    const terminal = events.findIndex((event) => TERMINAL_FRAME.test(event));
    const snapshot = events.findIndex((event) => event.includes('chunk-000'));
    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeGreaterThan(snapshot);
    expect(events[snapshot]).toContain('chunk-010');
    expect(events[snapshot]).not.toContain(LONG_REPLY_LAST_CHUNK);
    expect(terminal - snapshot).toBeGreaterThan(1);
  });
});
