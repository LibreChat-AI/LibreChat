import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

const ORDERED_PIECE_COUNT = 64;

const orderedPieces = () =>
  Array.from(
    { length: ORDERED_PIECE_COUNT },
    (_, index) => `piece-${String(index).padStart(3, '0')}`,
  );

test.describe('stream transport fidelity', () => {
  test('renders and persists every LLM chunk exactly once and in order', async ({ page }) => {
    const label = `ordered-${Date.now()}`;
    const expected = `E2E ordered reply ${label} ${orderedPieces().join(' ')}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessageAndWaitForCompletion(page, `E2E_ORDERED_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();

    const assistantContent = messagesView(page)
      .locator('.message-render')
      .last()
      .locator('.message-content');
    await expect(assistantContent).toContainText('piece-010', { timeout: 30000 });
    await expect(assistantContent).toHaveText(expected, { timeout: 30000 });

    await page.reload({ timeout: 10000 });
    await expect(
      messagesView(page).locator('.message-render').last().locator('.message-content'),
    ).toHaveText(expected, { timeout: 30000 });
  });
});
