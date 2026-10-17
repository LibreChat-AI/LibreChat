import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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
const STREAM_ROUTE = /\/api\/agents\/chat\/stream\//;

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const assistantTurn = (page: Page) =>
  messagesView(page)
    .locator('.message-render')
    .filter({ has: page.locator('.agent-turn') })
    .last();

const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });

/** Reads `12s` or `1m 3s` as whole seconds. */
const toSeconds = (reading: string): number => {
  const match = /^(?:(\d+)m )?(\d+)s$/.exec(reading.trim());
  if (!match) {
    throw new Error(`Unexpected elapsed reading: ${reading}`);
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2]);
};

test.describe('run indicators', () => {
  test('a live reply shows the stop button and a ticking elapsed reading until it settles @scenario:live-run-shows-stop-and-elapsed-until-it-settles', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('run-indicators');

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });

    await expect(stopButton(page)).toBeVisible();
    const elapsed = assistantTurn(page).getByTestId('stream-elapsed');
    await expect(elapsed).toHaveText(/^\d+s$/);
    const firstReading = (await elapsed.textContent()) ?? '';
    await expect(elapsed).not.toHaveText(firstReading, { timeout: 5_000 });

    await expect(stopButton(page)).toBeHidden({ timeout: 60_000 });
    await expect(elapsed).toHaveCount(0);
  });

  test('the elapsed reading keeps counting from the run start across a reload, and stopping clears it @scenario:elapsed-reading-survives-a-reload-mid-run', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('run-indicators-reload');

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** The long reply runs in an already persisted conversation, so the reload
     *  lands on it while the reply is still streaming. */
    const setup = await sendMessage(page, replyPrompt(`${label}-setup`));
    expect(setup.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(`${label}-setup`))).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15_000 });

    const response = await sendMessage(page, `${LONG_REPLY_MARKER}:${label}`);
    expect(response.ok()).toBeTruthy();
    const elapsed = assistantTurn(page).getByTestId('stream-elapsed');
    await expect(elapsed).toHaveText(/^[3-9]s$/, { timeout: 15_000 });
    const beforeReload = toSeconds((await elapsed.textContent()) ?? '');

    const reattached = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'GET' &&
        STREAM_ROUTE.test(new URL(candidate.url()).pathname) &&
        candidate.url().includes('resume=true'),
      { timeout: 30_000 },
    );
    await page.reload();
    expect((await reattached).status()).toBe(200);

    /** A reload that restarted the count would read below the pre-reload value. */
    const resumedElapsed = assistantTurn(page).getByTestId('stream-elapsed');
    await expect(resumedElapsed).toHaveText(/^\d+s$/, { timeout: 15_000 });
    expect(toSeconds((await resumedElapsed.textContent()) ?? '')).toBeGreaterThanOrEqual(
      beforeReload,
    );
    await expect(stopButton(page)).toBeVisible();

    const [abort] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          candidate.url().includes('/api/agents/chat/abort'),
        { timeout: 30_000 },
      ),
      stopButton(page).click(),
    ]);
    expect(abort.ok()).toBeTruthy();
    await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });
    await expect(resumedElapsed).toHaveCount(0);
  });
});
