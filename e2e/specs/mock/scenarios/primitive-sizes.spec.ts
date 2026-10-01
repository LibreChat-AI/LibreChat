import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The size roles the shared primitives draw with. The default theme keeps every size the
 * primitives drew as fixed utilities, in both modes; the ClickHouse theme takes Click UI's single
 * button size, its small icon button and its icon, checkbox and dialog close sizes.
 */

type Mode = 'light' | 'dark';

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

async function sizes(page: Page): Promise<Record<string, string>> {
  const probes: Array<[string, string]> = [
    ['h-theme-button-xs', 'height'],
    ['h-theme-button-lg', 'height'],
    ['size-theme-button', 'width'],
    ['size-theme-icon-button-sm', 'width'],
    ['size-theme-checkbox', 'width'],
    ['size-theme-icon', 'width'],
    ['size-theme-icon-lg', 'width'],
    ['h-theme-field-lg', 'height'],
    ['h-theme-field', 'height'],
    ['h-theme-target', 'height'],
    ['min-w-theme-target', 'min-width'],
    ['min-w-theme-tab', 'min-width'],
    ['select-item', 'border-top-left-radius'],
  ];
  const result: Record<string, string> = {};
  for (const [classes, property] of probes) {
    result[classes] = await probeStyle(page, classes, property);
  }
  return result;
}

/** Names the icon and target sizes apart from every default, so a size still drawn by a fixed
 *  utility shows. */
const REFERENCE_SIZE_THEME = {
  version: 1,
  name: 'e2e-size-reference',
  modes: {
    light: { appearance: { iconSize: '1.5rem', minTargetSize: '2rem' } },
    dark: { appearance: { iconSize: '1.5rem', minTargetSize: '2rem' } },
  },
} as const;

const DEFAULT_SIZES = {
  'h-theme-button-xs': '28px',
  'h-theme-button-lg': '44px',
  'size-theme-button': '40px',
  'size-theme-icon-button-sm': '32px',
  'size-theme-checkbox': '16px',
  'size-theme-icon': '16px',
  'size-theme-icon-lg': '24px',
  'h-theme-field-lg': '48px',
  'h-theme-field': '40px',
  'h-theme-target': '24px',
  'min-w-theme-target': '24px',
  'min-w-theme-tab': '100px',
  'select-item': '8px',
};

test.describe('primitive size roles', () => {
  test('the default theme keeps every primitive size in both modes @scenario:primitive-sizes-default-unchanged', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode);

      const drawn = await sizes(modePage);
      expect(drawn).toEqual(DEFAULT_SIZES);
      /** A field and the icon buttons beside it (the passkey rename row) stay one height. */
      expect(drawn['h-theme-field']).toBe(drawn['size-theme-button']);
    }
  });

  test('the ClickHouse theme sizes buttons, icons and menu rows from Click UI @scenario:primitive-sizes-clickhouse', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, clickHouseTheme);

      const drawn = await sizes(modePage);
      expect(drawn['h-theme-field']).toBe(drawn['size-theme-button']);
      expect(drawn).toEqual({
        ...DEFAULT_SIZES,
        'h-theme-button-lg': '32px',
        'size-theme-button': '32px',
        'size-theme-icon-button-sm': '24px',
        'select-item': '4px',
        'min-w-theme-tab': '0px',
        'h-theme-field': '32px',
      });
    }
  });

  test('a theme naming its own icon and target sizes resizes a menu glyph and the hit area @scenario:primitive-sizes-reference-theme', async ({
    page,
  }) => {
    await openChat(page, 'light', REFERENCE_SIZE_THEME);

    /** The menu row's icon slot, holding a glyph a caller sized itself, as the export menu does. */
    const glyph = await page.evaluate(() => {
      const slot = document.createElement('span');
      slot.className = 'size-theme-icon mr-2 [&>svg]:size-theme-icon';
      slot.innerHTML = '<svg class="size-4" viewBox="0 0 24 24"></svg>';
      document.body.append(slot);
      const width = getComputedStyle(slot.querySelector('svg') as SVGElement).width;
      slot.remove();
      return width;
    });
    expect(glyph).toBe('24px');
    expect(await probeStyle(page, 'h-theme-target', 'height')).toBe('32px');
  });
});
