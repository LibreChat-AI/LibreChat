import { expect, test } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * The context gauge counts a reply as it is written: the reading the server sends when the
 * reply starts, plus the output that has arrived since.
 */
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The gauge's used-token count, read from its accessible name. */
const used = (label: string | null): number => {
  const match = /Context window: ([\d.,]+)(K?) of/.exec(label ?? '');
  if (match == null) {
    throw new Error(`The gauge does not say how much is used: ${label}`);
  }
  return Number(match[1].replace(/,/g, '')) * (match[2] === 'K' ? 1000 : 1);
};

test('the gauge keeps counting while a reply streams @scenario:context-gauge-follows-a-streaming-reply', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const label = uniqueLabel('gauge');
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const first = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(first.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible();

  const form = page.locator('main form').first();
  const gauge = form.getByTestId('token-usage');
  await form.getByRole('textbox', { name: 'Message input' }).click();
  await page.keyboard.type(`E2E_SLOW_REPLY:${label}`);
  await page.keyboard.press('Enter');

  /**
   * Early in the reply, and again well into it, both while it is still being written: more has
   * arrived, so more is used. Read as they stand, with no waiting that could run past the end
   * of the reply, where the count settles whatever it did meanwhile.
   */
  const stop = page.getByRole('button', { name: 'Stop generating' });
  await expect(messagesView(page)).toContainText('chunk-020', { timeout: 30_000 });
  const early = used(await gauge.getAttribute('aria-label'));
  await expect(messagesView(page)).toContainText('chunk-100', { timeout: 60_000 });
  const late = used(await gauge.getAttribute('aria-label'));
  await expect(stop).toBeVisible();
  expect(late).toBeGreaterThan(early);

  /** The settled count is not below what it showed on the way. */
  await expect(messagesView(page)).toContainText('chunk-159', { timeout: 60_000 });
  await expect(stop).toHaveCount(0);
  await expect
    .poll(async () => used(await gauge.getAttribute('aria-label')), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(late - 5);
});
