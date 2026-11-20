import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

const LONG_THINK_WORDS = 400;
const reasoningWords = Array.from(
  { length: LONG_THINK_WORDS },
  (_, index) => `r${String(index).padStart(3, '0')}`,
);
const expectedReasoning = (label: string) =>
  `E2E long reasoning ${label} ${reasoningWords.join(' ')} end`;

test.describe('long reasoning stream', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('showThinking', 'true');
      window.localStorage.setItem('smoothStreaming', 'true');
    });
  });

  test('keeps only the newest reasoning words in fade spans and reveals the full text in order @scenario:long-reasoning-stream-settles-prefix-and-shows-full-text', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = `long-think-${Date.now()}`;
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, `E2E_LONG_THINK_REPLY:${label}`);
    expect(response.ok()).toBeTruthy();

    const assistantMessage = messagesView(page).locator('.message-render').last();
    const reasoning = assistantMessage.locator('p', { hasText: `E2E long reasoning ${label}` });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(reasoning).toContainText('r200', { timeout: 30_000 });

    const midStream = await reasoning.evaluate((node) => ({
      text: node.textContent ?? '',
      fading: node.querySelectorAll('span[data-lc-fade]').length,
      children: node.childNodes.length,
    }));
    expect(expectedReasoning(label).startsWith(midStream.text)).toBe(true);
    expect(midStream.fading).toBeLessThan(40);
    expect(midStream.children).toBeLessThan(60);

    await expect(assistantMessage.getByText(`E2E reply ${label}`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(reasoning).toHaveText(expectedReasoning(label));
  });
});
