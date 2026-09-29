import { expect, test } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  enableCodeInterpreter,
  selectMockEndpoint,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
} from '../helpers';

/**
 * The code window header used to repaint its panel with a per-mode fill that matched the panel
 * in every bundled theme. It now paints nothing, so the header always shows the panel's own
 * `surface-secondary`, including in a theme where the two roles differ.
 */
test('the code window header shows its panel surface @scenario:code-window-header-shows-its-panel', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const label = `header-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await enableCodeInterpreter(page);

  const response = await sendMessageAndWaitForCompletion(page, `E2E_EXECUTE_CODE:${label}`);
  expect(response.ok()).toBeTruthy();

  const card = messagesView(page).getByRole('button', { name: /^Finished running/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();

  const copy = messagesView(page).getByRole('button', { name: 'Copy code' }).first();
  await expect(copy).toBeVisible({ timeout: 15_000 });

  const paint = await copy.evaluate((button) => {
    const header = button.parentElement as HTMLElement;
    const panel = header.parentElement as HTMLElement;
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'rgb(var(--surface-secondary))';
    document.body.appendChild(probe);
    const surfaceSecondary = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      header: getComputedStyle(header).backgroundColor,
      panel: getComputedStyle(panel).backgroundColor,
      surfaceSecondary,
    };
  });
  expect(paint.header).toBe('rgba(0, 0, 0, 0)');
  expect(paint.panel).toBe(paint.surfaceSecondary);
});
