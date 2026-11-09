import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * WCAG 2.5.8's 24px target minimum reaches the Button's default and `sm` heights and the OGDialog
 * close button. The default theme keeps every size it drew; a stored theme naming a
 * smaller Button height still loads, and draws its Buttons at the floor.
 */

type Mode = 'light' | 'dark';

/** Button heights under the floor, which the theme validator has always accepted. */
const SMALL_BUTTON_THEME = {
  version: 1,
  name: 'e2e-small-buttons',
  modes: {
    light: { appearance: { buttonHeight: '0', buttonHeightSm: '1rem' } },
    dark: { appearance: { buttonHeight: '0', buttonHeightSm: '1rem' } },
  },
} as const;

async function openChat(page: Page, mode: Mode, definition?: { name: string }) {
  await page.addInitScript(
    ([colorTheme, stored]) => {
      localStorage.setItem('color-theme', colorTheme as string);
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (stored) {
        localStorage.setItem('theme-definition', JSON.stringify(stored));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    [mode, definition ?? null] as [string, unknown],
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
  if (definition) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', definition.name);
  }
}

async function buttonSizes(page: Page): Promise<Record<string, string>> {
  return {
    'h-theme-button': await probeStyle(page, 'h-theme-button', 'height'),
    'h-theme-button-sm': await probeStyle(page, 'h-theme-button-sm', 'height'),
    'size-theme-button': await probeStyle(page, 'size-theme-button', 'width'),
  };
}

test.describe('target floor', () => {
  test('the default theme keeps the default and sm Button heights in both modes @scenario:button-height-floor-default', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode);
      expect(await buttonSizes(modePage)).toEqual({
        'h-theme-button': '40px',
        'h-theme-button-sm': '36px',
        'size-theme-button': '40px',
      });
    }
  });

  test('a stored theme with Button heights under 24px loads and draws them at 24px @scenario:button-height-floor-theme', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, SMALL_BUTTON_THEME);
      expect(await buttonSizes(modePage)).toEqual({
        'h-theme-button': '24px',
        'h-theme-button-sm': '24px',
        'size-theme-button': '24px',
      });
    }
  });

  test('the OGDialog close button is a 24px target with its glyph inside it @scenario:ogdialog-close-target', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await modePage.addInitScript((selected) => {
        localStorage.setItem('color-theme', selected);
      }, mode);
      await modePage.goto('/agents/all', { timeout: 15000 });
      await expect(modePage.locator('html')).toHaveClass(
        mode === 'dark' ? /\bdark\b/ : /\blight\b/,
      );
      await modePage.getByRole('button', { name: 'Admin Settings' }).click();
      const dialog = modePage.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 15000 });
      /** The dialog animates in, so its close control is only measurable once it settles. */
      await dialog.evaluate((element) =>
        Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        ),
      );

      const close = dialog.getByRole('button', { name: 'Close' });
      const [box, glyph] = await Promise.all([
        close.boundingBox(),
        close.locator('svg').boundingBox(),
      ]);
      expect(box && glyph).toBeTruthy();
      if (!box || !glyph) {
        return;
      }
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      expect(glyph.x).toBeGreaterThanOrEqual(box.x - 0.5);
      expect(glyph.y).toBeGreaterThanOrEqual(box.y - 0.5);
      expect(glyph.x + glyph.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      expect(glyph.y + glyph.height).toBeLessThanOrEqual(box.y + box.height + 0.5);

      await close.focus();
      await modePage.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
    }
  });
});
