import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * iOS zooms into a focused field whose text is under 16px, and the installed PWA
 * never zooms back out. A touch device keeps every shared field at 16px or more;
 * a pointer-only desktop keeps the compact 14px scale.
 */

const IOS_ZOOM_THRESHOLD = 16;

const loggedOut = { storageState: { cookies: [], origins: [] } };

async function emailFontSize(page: Page): Promise<number> {
  await page.goto('/login', { timeout: 10000 });
  const email = page.locator('#email');
  await expect(email).toBeVisible();
  return email.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
}

test.describe('focused text fields do not trigger iOS zoom', () => {
  test.describe('touch device', () => {
    test.use({ ...loggedOut, hasTouch: true });

    test('the login email field is at least 16px @scenario:touch-login-field-no-zoom', async ({
      page,
    }) => {
      expect(await emailFontSize(page)).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD);
    });
  });

  test.describe('touch device, explicit sizes', () => {
    test.use({ ...loggedOut, hasTouch: true });

    test('controls sized below 16px are floored and larger ones kept @scenario:touch-explicit-sizes-floored', async ({
      page,
    }) => {
      await page.goto('/login', { timeout: 10000 });
      await expect(page.locator('#email')).toBeVisible();
      const sizes = await page.evaluate(() => {
        const make = (tag: string, className: string, type?: string) => {
          const node = document.createElement(tag);
          node.className = className;
          if (type) {
            (node as HTMLInputElement).type = type;
          }
          document.body.appendChild(node);
          return parseFloat(getComputedStyle(node).fontSize);
        };
        return {
          small: make('input', 'text-xs', 'text'),
          date: make('input', 'text-sm', 'date'),
          area: make('textarea', 'text-sm'),
          select: make('select', 'text-sm'),
          heading: make('input', 'text-2xl', 'text'),
        };
      });
      expect(sizes.small).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD);
      expect(sizes.date).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD);
      expect(sizes.area).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD);
      expect(sizes.select).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD);
      expect(sizes.heading).toBe(24);
    });
  });

  test.describe('pointer only', () => {
    test.use(loggedOut);

    test('the login email field keeps the compact scale on desktop @scenario:desktop-field-scale-unchanged', async ({
      page,
    }) => {
      const matchesCoarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
      test.skip(matchesCoarse, 'this project emulates a touch device');
      expect(await emailFontSize(page)).toBe(14);
    });
  });

  test.describe('signed in touch device', () => {
    test.use({ hasTouch: true });

    test('the chat composer is at least 16px @scenario:touch-composer-no-zoom', async ({
      page,
    }) => {
      await page.goto('/c/new', { timeout: 10000 });
      const composer = page.getByRole('textbox', { name: 'Message input' });
      await expect(composer).toBeVisible();
      const size = await composer.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
      expect(size).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD);
    });
  });
});
