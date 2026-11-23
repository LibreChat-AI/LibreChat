import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH, mockReply, sendMessage } from '../helpers';

/**
 * The conversation menu trigger in the phone-width chat header uses the `header-action` Button variant, so it
 * reads as the same persistent control as the sidebar toggle beside it: a 12px corner, a 1px
 * chrome edge.
 */

test('@scenario:default-theme-chat-header-unchanged header menu trigger keeps its shape in both modes', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await sendMessage(page, 'header action buttons');
  await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
  for (const mode of ['light', 'dark']) {
    await page.evaluate((appearance) => localStorage.setItem('color-theme', appearance), mode);
    await page.reload();
    const trigger = page.getByTestId('header-overflow-menu');
    await expect(trigger).toBeVisible({ timeout: 30000 });
    const style = await trigger.evaluate((node) => {
      const computed = getComputedStyle(node);
      return {
        radius: computed.borderTopLeftRadius,
        width: computed.borderTopWidth,
      };
    });
    expect(style).toEqual({ radius: '12px', width: '1px' });
  }
});
