import { expect, test } from '@playwright/test';
import {
  messagesView,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

test('Inspecting numeric reasoning preserves Auto and steering @scenario:inspecting-numeric-reasoning-preserves-auto-and-steering', async ({
  page,
}) => {
  await page.route('**/api/endpoints', async (route) => {
    const response = await route.fetch();
    const endpoints = await response.json();
    endpoints['Mock Provider A'].customParams = {
      defaultParamsEndpoint: 'google',
      paramDefinitions: [
        {
          key: 'thinkingBudget',
          type: 'number',
          default: -1,
          range: { min: -1, positiveMin: 128, max: 32768, step: 128 },
        },
      ],
    };
    await route.fulfill({ response, json: endpoints });
  });
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, `E2E_SLOW_REPLY:numeric-reasoning-${Date.now()}`);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill('Keep steering after inspecting Auto');
  const send = page.getByTestId('during-run-send-button');
  await expect(send).toHaveAttribute('data-during-run-action', 'steer');
  const reasoning = page.getByRole('button', { name: /Reasoning for next message.*Auto/i });
  await reasoning.click();
  const budget = page.getByRole('spinbutton');
  await expect(budget).toHaveValue('');
  await budget.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(reasoning).toBeFocused();
  await expect(send).toHaveAttribute('data-during-run-action', 'steer');
  await expect(input).toHaveValue('Keep steering after inspecting Auto');

  await reasoning.click();
  await budget.fill('4096');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await budget.fill('');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(budget).toHaveValue('');
  await page.keyboard.press('Escape');
  await input.clear();
  await page.getByRole('button', { name: 'Stop generating' }).click();
});
