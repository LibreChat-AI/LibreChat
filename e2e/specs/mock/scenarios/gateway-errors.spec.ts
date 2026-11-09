import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * The fake model throws `E2E_GATEWAY_ERROR:<CODE>:<label>` mid-stream with the status code, a
 * gateway's explanation and LangChain's troubleshooting URL, so the run classifies the failure.
 * The e2e deployment runs without content protection, so the explanation may reach the reader.
 */
const RATE_LIMIT_COPY =
  "The provider declined this request for exceeding a rate or spending limit. Wait a moment and try again, or ask an administrator to review the provider's limits.";
const MODEL_NOT_FOUND_COPY =
  'The selected model is unavailable from this provider. Select a different model or ask an administrator to verify the provider configuration.';

const explanation = (label: string) =>
  `Gateway budget for ${label} is spent. Waiting will not help; ask an administrator for more.`;

async function failTurn(page: Page, prompt: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, prompt);
  expect(response.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15_000 });
}

async function expectSettled(page: Page) {
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
}

test.describe('classified provider failures', () => {
  test("a rate limited turn shows the limit sentence with the gateway's own explanation @scenario:gateway-rate-limit-shows-its-message", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = `rate-${Date.now()}`;
    await failTurn(page, `E2E_GATEWAY_ERROR:MODEL_RATE_LIMIT:${label}`);

    const view = messagesView(page);
    await expect(view.getByText(RATE_LIMIT_COPY)).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText(explanation(label), { exact: true })).toBeVisible();
    await expect(view.getByText('Troubleshooting URL')).toHaveCount(0);
    await expect(view.getByText(`429 ${explanation(label)}`)).toHaveCount(0);
    await expectSettled(page);

    await page.reload();
    await expect(view.getByText(RATE_LIMIT_COPY)).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText(explanation(label), { exact: true })).toBeVisible();
  });

  test('a rate limited turn without an explanation shows only the limit sentence @scenario:bare-rate-limit-shows-only-the-sentence', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = `bare-${Date.now()}`;
    await failTurn(page, `E2E_BARE_GATEWAY_ERROR:MODEL_RATE_LIMIT:${label}`);

    const view = messagesView(page);
    const sentence = view.getByText(RATE_LIMIT_COPY, { exact: true });
    await expect(sentence).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText('Provider response')).toHaveCount(0);
    await expect(view.getByText('Troubleshooting URL')).toHaveCount(0);
    await expect(view.getByText(/^429$/)).toHaveCount(0);
    await expectSettled(page);

    await page.reload();
    await expect(view.getByText(RATE_LIMIT_COPY, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("a turn on a model the gateway does not serve shows the model sentence with the gateway's explanation @scenario:gateway-model-not-found-shows-its-message", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = `model-${Date.now()}`;
    await failTurn(page, `E2E_GATEWAY_ERROR:MODEL_NOT_FOUND:${label}`);

    const view = messagesView(page);
    await expect(view.getByText(MODEL_NOT_FOUND_COPY)).toBeVisible({ timeout: 30_000 });
    await expect(view.getByText(explanation(label), { exact: true })).toBeVisible();
    await expect(view.getByText('Troubleshooting URL')).toHaveCount(0);
    await expectSettled(page);
  });
});
