import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';
import { probeStyle } from './style.helpers';
import { openSidebar } from './sidebar';

/**
 * WCAG 2.5.8's 24px target minimum reaches the Button's default and `sm` heights and the exported
 * Dialog's close button. The default theme keeps every size it drew; a stored theme naming a
 * smaller Button height still loads, and draws its Buttons at the floor.
 */

type Mode = 'light' | 'dark';
type CreatedAssistant = { id: string };

const ASSISTANT_NAME = 'E2E dialog close target assistant';

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

  test('the exported Dialog close button is a 24px target with its glyph in place @scenario:dialog-close-target', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto('/c/new', { timeout: 10000 });
    const token = await getAccessToken(page);
    const assistant = await requestJson<CreatedAssistant>(page, {
      path: '/api/assistants/v2',
      token,
      method: 'POST',
      body: { endpoint: 'assistants', model: 'gpt-4o-mini', name: ASSISTANT_NAME },
    });

    try {
      for (const mode of ['light', 'dark'] as const) {
        await page.addInitScript((selected) => {
          localStorage.setItem('color-theme', selected);
          localStorage.setItem('navVisible', 'true');
        }, mode);
        await page.goto('/c/new?endpoint=assistants&model=gpt-4o-mini', { timeout: 10000 });
        await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
        await openSidebar(page);
        const controlPanel = page.getByRole('button', { name: 'Control Panel' });
        if (await controlPanel.isVisible()) {
          await controlPanel.click();
          await page.getByRole('menuitemcheckbox', { name: 'Assistant Builder' }).click();
        } else {
          await page.getByRole('button', { name: 'Assistant Builder' }).first().click();
        }
        const picker = page.getByTestId('select-dropdown-button').first();
        await expect(picker.getByText(ASSISTANT_NAME, { exact: true })).toBeVisible();

        /** The delete control is the builder's only neutral button holding a destructive icon. */
        await page
          .locator('button.btn-neutral')
          .filter({ has: page.locator('.text-text-destructive') })
          .click();
        const dialog = page.getByRole('dialog', { name: 'Delete Assistant' });
        await expect(dialog).toBeVisible();

        const close = dialog.getByRole('button', { name: 'Close' });
        const [box, glyph, frame] = await Promise.all([
          close.boundingBox(),
          close.locator('svg').boundingBox(),
          dialog.boundingBox(),
        ]);
        expect(box && glyph && frame).toBeTruthy();
        if (!box || !glyph || !frame) {
          return;
        }
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
        /** The 20px glyph stays where it drew before the floor: 1.6rem down, 1.5rem in. */
        expect(glyph.width).toBeCloseTo(20, 0);
        expect(glyph.y - frame.y).toBeCloseTo(25.6, 0);
        expect(frame.x + frame.width - (glyph.x + glyph.width)).toBeCloseTo(24, 0);

        await close.focus();
        await page.keyboard.press('Enter');
        await expect(dialog).toBeHidden();
      }
    } finally {
      await requestJson(page, {
        path: `/api/assistants/v2/${encodeURIComponent(assistant.id)}?endpoint=assistants&model=gpt-4o-mini`,
        token,
        method: 'DELETE',
        body: { endpoint: 'assistants' },
      });
    }
  });
});
