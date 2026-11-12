import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  isAgentGenerationStart,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/** Rows built from the message leaves `@librechat/chat` now serves: sibling navigation, the
 *  streaming elapsed reading, and the header label. */

const uniqueLabel = (name: string) => `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const messagesView = (page: Page) => page.getByTestId('messages-view');
const messageRender = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();

async function openMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

async function sendAndExpectReply(page: Page, prompt: string, reply: string) {
  const response = await sendMessage(page, prompt);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(reply)).toBeVisible({ timeout: 30000 });
}

test.describe('message row leaves', () => {
  test.setTimeout(120000);

  test('sibling navigation pages between a reply and its regeneration @scenario:sibling-switch-pages-regenerated-replies', async ({
    page,
  }) => {
    const label = uniqueLabel('leaves-sibling');
    const firstReply = `E2E counted reply ${label} #1`;
    const regeneratedReply = `E2E counted reply ${label} #2`;

    await openMockChat(page);
    await sendAndExpectReply(page, `E2E_COUNTED_REPLY:${label}`, firstReply);

    const first = messageRender(page, firstReply);
    await first.hover();
    await Promise.all([
      page.waitForResponse(isAgentGenerationStart, { timeout: 30000 }),
      first.getByRole('button', { name: 'Regenerate', exact: true }).last().click(),
    ]);
    await expect(messagesView(page).getByText(regeneratedReply)).toBeVisible({ timeout: 30000 });

    const regenerated = messageRender(page, regeneratedReply);
    await regenerated.hover();
    const navigation = regenerated.getByRole('navigation', { name: 'Sibling message navigation' });
    await expect(navigation).toBeVisible();
    await expect(navigation).toContainText('2 / 2');

    await navigation.getByRole('button', { name: 'Previous sibling message' }).click();
    await expect(messagesView(page).getByText(firstReply)).toBeVisible();
    await expect(messagesView(page).getByText(regeneratedReply)).toBeHidden();

    const back = messageRender(page, firstReply);
    await back.hover();
    const firstNavigation = back.getByRole('navigation', { name: 'Sibling message navigation' });
    await expect(firstNavigation).toContainText('1 / 2');
    await firstNavigation.getByRole('button', { name: 'Next sibling message' }).focus();
    await page.keyboard.press('Enter');
    await expect(messagesView(page).getByText(regeneratedReply)).toBeVisible();
  });

  test('a streaming reply shows an elapsed reading that clears when it settles @scenario:streaming-footer-shows-elapsed-reading', async ({
    page,
  }) => {
    const label = uniqueLabel('leaves-elapsed');

    await openMockChat(page);
    const response = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();

    const reading = messagesView(page).getByTestId('stream-elapsed');
    await expect(reading).toBeVisible({ timeout: 30000 });
    await expect(reading).toHaveText(/^\d+(\.\d)?s$/);
    await expect(messagesView(page).getByText(`E2E slow reply ${label}`)).toBeVisible({
      timeout: 60000,
    });
    await expect(reading).toBeHidden({ timeout: 60000 });
  });

  test('an assistant reply is headed by its endpoint label @scenario:message-header-shows-endpoint-label', async ({
    page,
  }) => {
    const label = uniqueLabel('leaves-header');
    const reply = `E2E reply ${label}`;

    await openMockChat(page);
    await sendAndExpectReply(page, `E2E_REPLY:${label}`, reply);

    const row = messageRender(page, reply);
    await expect(row.getByText(MOCK_ENDPOINTS[0].label, { exact: true }).first()).toBeVisible();
  });
});
