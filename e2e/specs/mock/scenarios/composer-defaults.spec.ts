import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

const MCP_SERVER_TITLE = 'E2E Memory';
const PROVIDER_C = { label: 'Mock Provider C', model: 'mock-model-c' };
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });
const duringRunSendButton = (page: Page) => page.getByTestId('during-run-send-button');
const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function isSteerRequest(response: Response) {
  return (
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/agents/chat/steer'
  );
}

async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const serverItem = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true })).toBeVisible();
}

async function establishConversation(page: Page, label: string) {
  const setup = await sendMessage(page, replyPrompt(label));
  expect(setup.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
}

test.describe('composer defaults', () => {
  test('file manager opens from the account menu @scenario:file-manager-opens-from-the-account-menu', async ({
    page,
  }) => {
    test.setTimeout(60000);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const accountMenuButton = page.getByTestId('nav-user');
    await expect(accountMenuButton).toBeVisible();
    await accountMenuButton.click();

    const accountMenu = page.getByRole('menu');
    const filesItem = accountMenu.getByRole('menuitem', { name: 'My Files', exact: true });
    await expect(filesItem).toBeVisible();
    await filesItem.click();
    await expect(page.getByRole('dialog', { name: 'My Files' })).toBeVisible();
  });

  test('Enter during a run steers the current reply by default @scenario:enter-during-a-run-steers-the-current-reply-by-default', async ({
    page,
  }) => {
    test.setTimeout(150000);
    const label = uniqueLabel('default-steer');
    const steerText = `Default steer ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PROVIDER_C);
    await selectEphemeralMCP(page);
    await establishConversation(page, `default-steer-setup-${label}`);

    const run = await sendMessage(page, `E2E_STEER_TOOL_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    const input = messageInput(page);
    await input.fill(steerText);
    await expect(duringRunSendButton(page)).toBeVisible({ timeout: 5000 });
    await expect(duringRunSendButton(page)).toHaveAttribute('data-during-run-action', 'steer');

    const [steerResponse] = await Promise.all([
      page.waitForResponse(isSteerRequest, { timeout: 15000 }),
      input.press('Enter'),
    ]);
    expect(steerResponse.status()).toBe(202);
    await expect(page.getByTestId('pending-steers').filter({ hasText: steerText })).toHaveCount(1, {
      timeout: 10000,
    });
    await expect(
      messagesView(page).locator('[data-testid="steer-part"]:not([data-testid="pending-steers"] *)').filter({
        hasText: steerText,
      }),
    ).toHaveCount(1, { timeout: 60000 });
    await expect(messagesView(page).getByText(`E2E steer tool reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });
    await expect(messagesView(page).getByText(`[steers-seen=1] ${steerText}`)).toBeVisible({
      timeout: 30000,
    });
    await expect(messagesView(page).getByText(SLOW_REPLY_LAST_CHUNK)).toBeVisible({ timeout: 30000 });
  });
});
