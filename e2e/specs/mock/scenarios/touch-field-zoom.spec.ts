import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * iOS zooms into a focused field whose text is under 16px, and the installed PWA
 * never zooms back out. A touch device keeps every shared field at 16px or more;
 * a pointer-only desktop keeps the compact 14px scale.
 */

const IOS_ZOOM_THRESHOLD = 16;

test.use({ storageState: { cookies: [], origins: [] } });

async function emailFontSize(page: Page): Promise<number> {
  await page.goto('/login', { timeout: 10000 });
  const email = page.locator('#email');
  await expect(email).toBeVisible();
  return email.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
}

test.describe('focused text fields do not trigger iOS zoom', () => {
  test.describe('touch device', () => {
    test.use({ hasTouch: true });

    test('the login email field is at least 16px @scenario:touch-login-field-no-zoom', async ({
      page,
    }) => {
      expect(await emailFontSize(page)).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD);
    });
  });

  test.describe('pointer only', () => {
    test('the login email field keeps the compact scale on desktop @scenario:desktop-field-scale-unchanged', async ({
      page,
    }) => {
      const matchesCoarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
      test.skip(matchesCoarse, 'this project emulates a touch device');
      expect(await emailFontSize(page)).toBe(14);
    });
  });
});
