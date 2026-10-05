import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import {
  selectMockEndpoint,
  getAccessToken,
  messagesView,
  requestJson,
  fetchJson,
  sendMessage,
  replyPrompt,
  replyText,
  MOCK_REPLY_TEXT,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from '../helpers';

/**
 * The follow-up queue, its run-end signals and the interrupt-drain flag are chat-owned Jotai
 * state. Queueing and draining are covered by the composer-queue scenarios; these drive the
 * interrupt-drain flag through a real stopped run, and a run that ends while its chat is left.
 */

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const queuedRows = (page: Page) => page.getByTestId('queued-message-row');
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

/** Waits until the server has saved the slow run's complete reply. */
async function waitForServerToFinish(page: Page, conversationId: string) {
  const token = await getAccessToken(page);
  await expect
    .poll(
      async () => {
        const messages = await fetchJson<TMessage[]>(
          page,
          `/api/messages/${encodeURIComponent(conversationId)}`,
          token,
        );
        return messages.some(
          (message) =>
            !message.isCreatedByUser &&
            message.unfinished !== true &&
            JSON.stringify(message.content ?? message.text ?? '').includes('chunk-159'),
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
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

  test('a follow-up queued in a chat the user left sends on return @scenario:parked-run-end-drains-on-return', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('parked');
    const followUp = `Parked follow-up ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const conversationId = await establishConversation(page, `parked-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await typeDuringRun(page, followUp);
    await messageInput(page).press('ControlOrMeta+Enter');
    await expect(queuedRows(page).filter({ hasText: followUp })).toBeVisible({ timeout: 10000 });

    /** Leave through the router, not a reload, so the in-memory queue survives the visit. */
    await page.evaluate((path) => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, NEW_CHAT_PATH);
    await expect(page).toHaveURL(/\/c\/new$/);

    /** The run finishes while its chat is not on screen. */
    await waitForServerToFinish(page, conversationId);
    await expect(messagesView(page).getByText(followUp)).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}(\\?.*)?$`));
    await expect(
      messagesView(page).locator('.user-turn').filter({ hasText: followUp }),
    ).toBeVisible({ timeout: 30000 });
    await expect(queuedRows(page).filter({ hasText: followUp })).toHaveCount(0);
  });

  test('a follow-up queued before the user stopped and left the run stays queued on return @scenario:stopped-run-left-keeps-follow-up-queued', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('stopped');
    const followUp = `Stopped follow-up ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const conversationId = await establishConversation(page, `stopped-setup-${label}`);

    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });
    await typeDuringRun(page, followUp);
    await messageInput(page).press('ControlOrMeta+Enter');
    await expect(queuedRows(page).filter({ hasText: followUp })).toBeVisible({ timeout: 10000 });

    const stop = page.getByRole('button', { name: 'Stop generating' });
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 15000 });

    await page.evaluate((path) => {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, NEW_CHAT_PATH);
    await expect(page).toHaveURL(/\/c\/new$/);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}(\\?.*)?$`));
    await expect(queuedRows(page).filter({ hasText: followUp })).toBeVisible({ timeout: 15000 });
    await expect(
      messagesView(page).locator('.user-turn').filter({ hasText: followUp }),
    ).toHaveCount(0);
  });

  test('a follow-up queued in a chat the user left for a saved chat sends on return @scenario:parked-run-end-drains-after-switching-chats', async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width < 768, 'the conversation list is in the drawer below md');
    test.setTimeout(150000);
    const label = uniqueLabel('switched');
    const followUp = `Switched follow-up ${label}`;
    const otherTitle = `Other chat ${label}`;

    /** A saved chat to switch to, titled so its list row can be found. */
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const otherId = await establishConversation(page, `switched-other-${label}`);
    await requestJson(page, {
      path: '/api/convos/update',
      token: await getAccessToken(page),
      method: 'POST',
      body: { arg: { conversationId: otherId, title: otherTitle } },
    });

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const conversationId = await establishConversation(page, `switched-setup-${label}`);
    const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await typeDuringRun(page, followUp);
    await messageInput(page).press('ControlOrMeta+Enter');
    await expect(queuedRows(page).filter({ hasText: followUp })).toBeVisible({ timeout: 10000 });

    /** Leave the way a user does: pick the other saved chat in the conversation list. */
    await page.getByTestId('convo-item').filter({ hasText: otherTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${otherId}(\\?.*)?$`));

    await waitForServerToFinish(page, conversationId);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}(\\?.*)?$`));
    await expect(
      messagesView(page).locator('.user-turn').filter({ hasText: followUp }),
    ).toBeVisible({ timeout: 30000 });
    await expect(queuedRows(page).filter({ hasText: followUp })).toHaveCount(0);
  });
});
