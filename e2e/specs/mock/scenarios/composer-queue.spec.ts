import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  MOCK_REPLY_TEXT,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/** `E2E_SLOW_REPLY` emits 160 chunks with a 35ms delay between chunks. */
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const queuedRows = (page: Page) => page.getByTestId('queued-message-row');
const messageTurns = (page: Page) => messagesView(page).locator('.message-render');

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

/** Establish a persisted conversation before starting a run whose queue is
 * observed. This keeps the run and its follow-up turns in one thread. */
async function establishConversation(page: Page, label: string) {
  const setup = await sendMessage(page, replyPrompt(label));
  expect(setup.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
}

/** Fill while generation is active and wait for the dedicated submit control;
 * its primary action reflects the preference installed in beforeEach. */
async function typeDuringRun(page: Page, text: string) {
  const input = messageInput(page);
  await input.click();
  await input.fill(text);
  await expect(duringRunSendButton(page)).toBeVisible({ timeout: 5000 });
}

async function startSlowRun(page: Page, label: string) {
  const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
  expect(run.ok()).toBeTruthy();
  await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });
}

test.describe('composer queue rail', () => {
  test.beforeEach(async ({ page }) => {
    // Enter uses the queue route during a run; the modifier route remains the
    // alternate action, matching the user preference this contract exercises.
    await page.addInitScript(() => {
      localStorage.setItem('duringRunDefaultAction', JSON.stringify('queue'));
    });
  });

  test('Enter during a run queues the message and sends it when the run ends @scenario:enter-during-a-run-queues-the-message-and-sends-it-when-the-run-ends', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('queue-enter');
    const queueText = `Queued with Enter ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `queue-enter-setup-${label}`);

    await startSlowRun(page, label);
    await typeDuringRun(page, queueText);
    await messageInput(page).press('Enter');

    const row = queuedRows(page).filter({ hasText: queueText });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(duringRunSendButton(page)).toHaveAttribute('data-during-run-action', 'queue');

    // Clean completion drains the queued row as a new user turn, then its
    // ordinary fake-model answer completes in the same conversation.
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toBeVisible({
      timeout: 15000,
    });
    await expect(row).toHaveCount(0, { timeout: 60000 });
    await expect(messageTurns(page)).toHaveCount(6, { timeout: 30000 });
    await expect(messageTurns(page).nth(4)).toContainText(queueText);
    await expect(messageTurns(page).nth(4).locator('.user-turn')).toBeVisible();
    await expect(messageTurns(page).nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
    await expect(messageTurns(page).nth(5).locator('.agent-turn')).toBeVisible();
  });

  test('Queued rows reorder with the keyboard @scenario:queued-rows-reorder-with-the-keyboard', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('queue-reorder');
    const firstText = `First queued message ${label}`;
    const secondText = `Second queued message ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `queue-reorder-setup-${label}`);

    await startSlowRun(page, label);
    await typeDuringRun(page, firstText);
    await messageInput(page).press('Enter');
    await expect(queuedRows(page).filter({ hasText: firstText })).toBeVisible({ timeout: 10000 });

    await typeDuringRun(page, secondText);
    await messageInput(page).press('Enter');
    await expect(queuedRows(page)).toHaveCount(2, { timeout: 10000 });

    // The first row's handle owns ArrowDown; after the move, the second row is
    // the head that queue drain will send first.
    await queuedRows(page).first().getByTestId('queued-message-grip').press('ArrowDown');
    await expect(queuedRows(page).first()).toContainText(secondText);

    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toBeVisible({
      timeout: 15000,
    });
    await expect(queuedRows(page)).toHaveCount(0, { timeout: 60000 });
    await expect(messageTurns(page)).toHaveCount(8, { timeout: 45000 });

    // Verify the externally visible conversation order, including each answer,
    // rather than relying only on the transient rail order.
    await expect(messageTurns(page).nth(4)).toContainText(secondText);
    await expect(messageTurns(page).nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
    await expect(messageTurns(page).nth(6)).toContainText(firstText);
    await expect(messageTurns(page).nth(7)).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
  });

  test('Composer keeps typed text when the run finishes @scenario:composer-keeps-typed-text-when-the-run-finishes', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('queue-draft');
    const draftText = `Draft retained after run ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `queue-draft-setup-${label}`);

    await startSlowRun(page, label);
    await typeDuringRun(page, draftText);

    // The text was never submitted, so run completion must not replace the
    // composer's own draft with an empty value.
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toBeVisible({
      timeout: 15000,
    });
    await expect(messageInput(page)).toHaveValue(draftText);
    await expect(queuedRows(page)).toHaveCount(0);
  });
});
