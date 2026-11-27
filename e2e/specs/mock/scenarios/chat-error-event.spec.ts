import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * The fake model throws mid-stream for `E2E_FORCED_ERROR:`, so the server ends the
 * turn on the SSE `error` event; the transport parses that body as `ChatErrorData`.
 */
test.describe('served stream error', () => {
  test('a turn that fails mid-stream shows the provider error and settles the composer @scenario:failed-turn-shows-served-error', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = `served-error-${Date.now()}`;
    const providerError = `E2E forced stream error ${label}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, `E2E_FORCED_ERROR:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15_000 });

    await expect(messagesView(page).getByText(providerError)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled();

    await page.reload();
    await expect(messagesView(page).getByText(providerError)).toBeVisible({ timeout: 30_000 });
  });
});
