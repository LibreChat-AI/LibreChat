import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

test.describe.configure({ timeout: 60_000 });
test.use({ viewport: { width: 1280, height: 800 } });

test.describe('select arrow', () => {
  test('a native select draws its arrow in the text color of the active mode @scenario:select-arrow-follows-text-color', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await expect(page.locator('#prompt-textarea')).toBeVisible({ timeout: 15000 });

    const paint = await page.evaluate(() => {
      const select = document.createElement('select');
      document.body.append(select);
      const style = getComputedStyle(select);
      const result = {
        color: style.color,
        image: style.backgroundImage,
        dark: document.documentElement.classList.contains('dark'),
      };
      select.remove();
      return result;
    });

    expect(paint.image).toContain('linear-gradient');
    expect(paint.image).not.toContain('url(');
    expect(paint.image).toContain(paint.color);
  });
});
