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
const CONVERSATION_URL = /\/c\/[0-9a-fA-F-]{36}$/;

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const queuedRows = (page: Page) => page.getByTestId('queued-message-row');
const messageTurns = (page: Page) => messagesView(page).locator('.message-render');

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function establishConversation(page: Page, label: string) {
  const setup = await sendMessage(page, replyPrompt(label));
  expect(setup.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(CONVERSATION_URL, { timeout: 15000 });
}

async function startSlowRun(page: Page, label: string) {
  const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
  expect(run.ok()).toBeTruthy();
  await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });
}

/** Opens a conversation, starts a slow run, and queues one message behind it. */
async function queueBehindRun(page: Page, label: string, text: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await establishConversation(page, `${label}-setup`);
  await startSlowRun(page, label);
  const input = messageInput(page);
  await input.click();
  await input.fill(text);
  await expect(duringRunSendButton(page)).toBeVisible({ timeout: 5000 });
  await input.press('Enter');
  const row = queuedRows(page).filter({ hasText: text });
  await expect(row).toBeVisible({ timeout: 10000 });
  return row;
}

async function chooseRowOption(page: Page, row: ReturnType<typeof queuedRows>, name: string) {
  await row.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

test.describe('queue row actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('duringRunDefaultAction', JSON.stringify('queue'));
    });
  });

  test('A running composer offers one send control and no visible hint row @scenario:running-composer-offers-one-send-control-and-no-hint-row', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const label = uniqueLabel('one-send-control');
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishConversation(page, `${label}-setup`);
    await startSlowRun(page, label);

    const input = messageInput(page);
    await input.click();
    await input.fill('steer this later');
    await expect(duringRunSendButton(page)).toBeVisible({ timeout: 5000 });
    /* The separate round "Steer sooner" button beside Send is gone; its action stays in
       the send control's own menu. */
    await expect(page.getByTestId('interrupt-steer-button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Steer this response sooner' })).toHaveCount(0);
    /* No visible hint row: the shortcuts live only in the textarea's description. */
    await expect(page.getByTestId('composer-hints')).toHaveCount(0);
    const hint = page.locator('#composer-hint-0');
    await expect(hint).toHaveClass(/sr-only/);
    await expect(hint).not.toBeEmpty();
    await expect(input).toHaveAttribute('aria-describedby', /composer-hint-0/);
  });

  test('The trash button returns a queued message to the composer @scenario:queued-row-trash-returns-the-message-to-the-composer', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('queue-trash');
    const text = `Take this back ${label}`;
    const row = await queueBehindRun(page, label, text);

    await row.getByRole('button', { name: 'Remove message', exact: true }).click();
    await expect(row).toHaveCount(0, { timeout: 10000 });
    await expect(messageInput(page)).toHaveValue(text);

    /* The run ends without sending it: the words now belong to the composer only. */
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toBeVisible({
      timeout: 15000,
    });
    await expect(messageTurns(page)).toHaveCount(4);
    await expect(messageInput(page)).toHaveValue(text);
  });

  test('A disabled queued message waits past the run and sends once enabled @scenario:disabled-queued-message-waits-and-sends-once-enabled', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('queue-hold');
    const text = `Hold me ${label}`;
    const row = await queueBehindRun(page, label, text);

    await chooseRowOption(page, row, 'Disable Queue');
    await expect(row).toContainText('Will not send automatically');

    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toBeVisible({
      timeout: 15000,
    });
    /* The run-end drain skips the held row, so it stays in the rail unsent. */
    await expect(duringRunSendButton(page)).toHaveCount(0, { timeout: 15000 });
    await page.waitForTimeout(3000);
    await expect(row).toBeVisible();
    await expect(messageTurns(page)).toHaveCount(4);

    /* Enabling after the run ended wakes the drain itself; nothing else would. */
    await chooseRowOption(page, row, 'Enable Queue');
    await expect(row).toHaveCount(0, { timeout: 30000 });
    await expect(messageTurns(page)).toHaveCount(6, { timeout: 30000 });
    await expect(messageTurns(page).nth(4)).toContainText(text);
    await expect(messageTurns(page).nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30000 });
  });

  test('Start in a new chat sends the queued message as a fresh conversation @scenario:start-in-new-chat-sends-the-queued-message-as-a-fresh-conversation', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('queue-new-chat');
    const text = replyPrompt(label);
    const row = await queueBehindRun(page, `${label}-run`, text);
    const sourceUrl = page.url();

    await chooseRowOption(page, row, 'Start in a new chat');

    await expect(page).toHaveURL(CONVERSATION_URL, { timeout: 30000 });
    await expect.poll(() => page.url(), { timeout: 30000 }).not.toBe(sourceUrl);
    await expect(messageTurns(page).first()).toContainText(text, { timeout: 30000 });
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
    await expect(queuedRows(page)).toHaveCount(0);

    /* The source conversation does not also send it when its run ends. */
    await page.goto(sourceUrl, { timeout: 10000 });
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toBeVisible({
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
    await expect(messagesView(page).getByText(text, { exact: true })).toHaveCount(0);
  });
});
