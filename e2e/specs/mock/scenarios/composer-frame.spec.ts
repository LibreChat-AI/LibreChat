import { expect, test } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint } from '../helpers';

/**
 * The composer layout, drawn by the chat package's frame: a click on the surface's empty area
 * returns focus to the draft, while a popup trigger inside it keeps focus so its menu can open
 * and close normally (#15624).
 */
test.describe.configure({ timeout: 120_000 });

test.describe('composer frame', () => {
  test('a click on the surface focuses the draft, a popup trigger keeps it @scenario:composer-surface-click-focuses-draft', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const input = page.getByRole('textbox', { name: 'Message input' });
    const surface = page.getByTestId('composer-surface');

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(input).not.toBeFocused();

    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await surface.click({ position: { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) - 6 } });
    await expect(input).toBeFocused();

    const trigger = surface.locator('[aria-haspopup]:not([aria-haspopup="false"])').first();
    await trigger.click();
    await expect(input).not.toBeFocused();
    await page.keyboard.press('Escape');
  });
});
