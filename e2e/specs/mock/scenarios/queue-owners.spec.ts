import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  selectMockEndpoint,
  messagesView,
  sendMessage,
  replyPrompt,
  replyText,
  MOCK_REPLY_TEXT,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from '../helpers';

/**
 * The follow-up queue, its run-end signals and the interrupt-drain flag are chat-owned Jotai
 * state. Queueing and draining are covered by the composer-queue scenarios; this one drives the
 * interrupt-drain flag through a real stopped run.
 */

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const messageTurns = (page: Page) => messagesView(page).locator('.message-render');
const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function establishConversation(page: Page, label: string): Promise<string> {
  const setup = await sendMessage(page, replyPrompt(label));
  expect(setup.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

async function typeDuringRun(page: Page, text: string) {
  const input = messageInput(page);
  await input.click();
  await input.fill(text);
  await expect(duringRunSendButton(page)).toBeVisible({ timeout: 5000 });
}

test.describe('chat-owned queue state', () => {
  test.beforeEach(async ({ page }) => {
    /** Steer is the plain-Enter default here, so Cmd/Ctrl+Enter is the queue path. */
    await page.addInitScript(() => {
      localStorage.setItem('duringRunDefaultAction', JSON.stringify('steer'));
    });
  });

  test('interrupt and send stops the run and sends the follow-up next @scenario:interrupt-and-send-drains-the-follow-up', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('interrupt');
    const followUp = `Interrupt follow-up ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `interrupt-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    await typeDuringRun(page, followUp);
    await messageInput(page).press('Alt+Enter');

    await expect(messageTurns(page)).toHaveCount(6, { timeout: 60000 });
    await expect(messageTurns(page).nth(4)).toContainText(followUp);
    await expect(messageTurns(page).nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
    await expect(messagesView(page).getByText('chunk-159')).toHaveCount(0);
  });
});
