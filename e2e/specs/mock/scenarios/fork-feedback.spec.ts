import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint, sendMessage } from '../helpers';

/** The fork and feedback actions `@librechat/chat` now renders on a reply, with the fork request
 *  and the viewer's fork defaults supplied by the app's messages host. */

const uniqueLabel = (name: string) => `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const messagesView = (page: Page) => page.getByTestId('messages-view');
const messageRender = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();

async function replyInNewChat(page: Page, label: string) {
  const reply = `E2E reply ${label}`;
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, `E2E_REPLY:${label}`);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(reply)).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/(?!new)[^/]+$/);
  return reply;
}

test.describe('fork and feedback actions', () => {
  test.setTimeout(120000);

  test('forking the visible branch opens the copy @scenario:fork-visible-branch-opens-copy', async ({
    page,
  }) => {
    const reply = await replyInNewChat(page, uniqueLabel('actions-fork'));
    const sourceUrl = page.url();

    const row = messageRender(page, reply);
    await row.hover();
    await row.getByRole('button', { name: 'Open Fork Menu' }).click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().includes('/api/convos/fork'),
        { timeout: 30000 },
      ),
      page.getByRole('button', { name: 'Visible messages only', exact: true }).click(),
    ]);
    expect(response.ok()).toBeTruthy();
    const { conversation } = (await response.json()) as {
      conversation: { conversationId: string };
    };

    await expect(page).toHaveURL(new RegExp(`/c/${conversation.conversationId}$`));
    expect(page.url()).not.toBe(sourceUrl);
    await expect(page.getByText('Successfully forked conversation', { exact: true })).toBeVisible();
    await expect(messagesView(page).getByText(reply)).toBeVisible();
  });

  test('a positive rating is saved and survives a reload @scenario:feedback-rating-persists', async ({
    page,
  }) => {
    const reply = await replyInNewChat(page, uniqueLabel('actions-feedback'));

    const row = messageRender(page, reply);
    await row.hover();
    await row.getByRole('button', { name: 'Love this' }).click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'PUT' && res.url().includes('/feedback'),
        { timeout: 30000 },
      ),
      page.locator('.popover-animate').getByRole('button').first().click(),
    ]);
    expect(response.ok()).toBeTruthy();

    const rated = row.getByRole('button', { name: 'Love this' });
    await expect(rated).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    const reloaded = messageRender(page, reply);
    await reloaded.hover();
    await expect(reloaded.getByRole('button', { name: 'Love this' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
