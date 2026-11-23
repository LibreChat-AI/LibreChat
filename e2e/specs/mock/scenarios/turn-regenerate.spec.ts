import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  isAgentGenerationStart,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

const uniqueLabel = (name: string) => `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const messagesView = (page: Page) => page.getByTestId('messages-view');
const messageRender = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();

async function regenerate(page: Page, reply: string) {
  const row = messageRender(page, reply);
  await row.hover();
  await Promise.all([
    page.waitForResponse(isAgentGenerationStart, { timeout: 30000 }),
    row.getByRole('button', { name: 'Regenerate', exact: true }).last().click(),
  ]);
}

/** A regeneration appends the newest sibling. When the parent already has siblings and an older
 *  one is on screen, the turn must still bring the new response into view. */
test.describe('turn regeneration', () => {
  test.setTimeout(120000);

  test('regenerating from an older sibling shows the new response @scenario:regenerate-from-older-sibling-shows-new-response', async ({
    page,
  }) => {
    const label = uniqueLabel('turn-regen');
    const reply = (n: number) => `E2E counted reply ${label} #${n}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessage(page, `E2E_COUNTED_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(reply(1))).toBeVisible({ timeout: 30000 });

    await regenerate(page, reply(1));
    await expect(messagesView(page).getByText(reply(2))).toBeVisible({ timeout: 30000 });

    const second = messageRender(page, reply(2));
    await second.hover();
    await second
      .getByRole('navigation', { name: 'Sibling message navigation' })
      .getByRole('button', { name: 'Previous sibling message' })
      .click();
    await expect(messagesView(page).getByText(reply(1))).toBeVisible();

    await regenerate(page, reply(1));
    await expect(messagesView(page).getByText(reply(3))).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByText(reply(1))).toBeHidden();
    const third = messageRender(page, reply(3));
    await third.hover();
    await expect(
      third.getByRole('navigation', { name: 'Sibling message navigation' }),
    ).toContainText('3 / 3');
  });
});
