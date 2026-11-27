import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NEW_CHAT_PATH, selectModelSpec, sendMessage } from './helpers';

const ICON_SPEC_LABEL = 'E2E Icon Spec';
const ICON_SPEC_URL = '/assets/openai.svg';

const uniqueLabel = (name: string) => `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const iconPrompt = (label: string) => `E2E_RESUME_ICON_REPLY:${label}`;
const iconReplyPrefix = (label: string) => `E2E resume icon reply ${label}`;

const assistantMessage = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();

const modelSpecIcon = (message: Locator) => message.locator(`img[src$="${ICON_SPEC_URL}"]`);

async function openIconSpecChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectModelSpec(page, ICON_SPEC_LABEL);
}

async function sendIconSpecStream(page: Page, label: string) {
  const response = await sendMessage(page, iconPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}(?:\?.*)?$/);

  const reply = iconReplyPrefix(label);
  const message = assistantMessage(page, reply);
  await expect(message.getByText(reply)).toBeVisible({ timeout: 30000 });
  await expect(modelSpecIcon(message)).toBeVisible();

  return { conversationUrl: page.url(), reply };
}

test.describe('model spec message icons', () => {
  test('preserves iconURL when resuming an active stream after navigation', async ({ page }) => {
    test.setTimeout(90000);
    const label = uniqueLabel('resume-icon');

    await openIconSpecChat(page);
    const { conversationUrl, reply } = await sendIconSpecStream(page, label);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await page.goto(conversationUrl, { timeout: 10000 });

    const resumedMessage = assistantMessage(page, reply);
    await expect(resumedMessage.getByText(reply)).toBeVisible({ timeout: 30000 });
    await expect(modelSpecIcon(resumedMessage)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();
  });

  test('preserves iconURL when aborting an active model spec stream', async ({ page }) => {
    test.setTimeout(90000);
    const label = uniqueLabel('abort-icon');

    await openIconSpecChat(page);
    const { reply } = await sendIconSpecStream(page, label);

    const [abortResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          response.url().includes('/api/agents/chat/abort'),
        { timeout: 30000 },
      ),
      page.getByRole('button', { name: 'Stop generating' }).click(),
    ]);
    expect(abortResponse.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30000,
    });

    const abortedMessage = assistantMessage(page, reply);
    await expect(abortedMessage.getByText(reply)).toBeVisible();
    await expect(modelSpecIcon(abortedMessage)).toBeVisible();

    await page.reload({ timeout: 10000 });
    const reloadedMessage = assistantMessage(page, reply);
    await expect(reloadedMessage.getByText(reply)).toBeVisible({ timeout: 30000 });
    await expect(modelSpecIcon(reloadedMessage)).toBeVisible();
  });
});
