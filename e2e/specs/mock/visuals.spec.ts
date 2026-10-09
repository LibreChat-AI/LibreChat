import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  isAgentsStream,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

test.describe('Inline visuals', () => {
  test('renders a visual inline in a sandboxed, themed frame', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const frameResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/visuals/frame',
    );
    const response = await sendMessageAndWaitForCompletion(page, 'E2E_VISUAL_REPLY');
    expect(response.ok()).toBeTruthy();

    const messages = messagesView(page);
    await expect(messages.getByText('Quarterly revenue', { exact: true })).toBeVisible();
    await expect(messages.getByText('The fourth quarter was the strongest.')).toBeVisible();

    const policy = (await frameResponse).headers()['content-security-policy'] ?? '';
    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).toContain("frame-ancestors 'self'");

    const iframe = messages.locator('iframe[title="Quarterly revenue"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    const frame = page.frameLocator('iframe[title="Quarterly revenue"]');
    await expect(frame.getByRole('img', { name: 'Revenue by quarter' })).toBeVisible();
    await expect(frame.locator('#probe')).toHaveText(
      'script ran, parent isolated, storage isolated, themed, fetch blocked',
    );

    /* The frame fits the page instead of keeping its 240px placeholder height. */
    const height = await iframe.evaluate((element) => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(190);
    expect(height).toBeLessThan(240);
    await expect(messages.locator('pre')).toHaveCount(0);
  });

  test('opens the visual in the artifacts panel with its source', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, 'E2E_VISUAL_REPLY');

    const messages = messagesView(page);
    await messages.getByRole('button', { name: 'Open in panel' }).click();
    const panelFrame = page.locator('iframe[title="Quarterly revenue"]').nth(1);
    await expect(panelFrame).toBeVisible();
    await expect(messages.getByRole('button', { name: 'Close panel' })).toBeVisible();
  });

  for (const [label, stored, expected] of [
    ['on by default', null, true],
    ['off when the user turned the setting off', 'false', false],
  ] as const) {
    test(`asks the server for inline visuals: ${label}`, async ({ page }) => {
      if (stored != null) {
        await page.addInitScript((value) => localStorage.setItem('inlineVisuals', value), stored);
      }
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill('E2E_VISUAL_REPLY');
      const [response] = await Promise.all([
        page.waitForResponse(isAgentsStream, { timeout: 30000 }),
        input.press('Enter'),
      ]);
      const body = response.request().postDataJSON() as { visuals?: boolean };
      expect(body.visuals).toBe(expected);
    });
  }
});
