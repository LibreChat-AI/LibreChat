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

const DEFAULT_SIZES = {
  'h-theme-button-xs': '28px',
  'h-theme-button-lg': '44px',
  'size-theme-button': '40px',
  'size-theme-icon-button-sm': '32px',
  'size-theme-checkbox': '16px',
  'size-theme-icon': '16px',
  'size-theme-icon-lg': '24px',
  'h-theme-field-lg': '48px',
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

      expect(await sizes(modePage)).toEqual(DEFAULT_SIZES);
    }
  });

  test('the ClickHouse theme sizes buttons, icons and menu rows from Click UI @scenario:primitive-sizes-clickhouse', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, clickHouseTheme);

      expect(await sizes(modePage)).toEqual({
        ...DEFAULT_SIZES,
        'h-theme-button-lg': '32px',
        'size-theme-button': '32px',
        'size-theme-icon-button-sm': '24px',
        'select-item': '4px',
        'min-w-theme-tab': '0px',
      });
    }
  });
});
