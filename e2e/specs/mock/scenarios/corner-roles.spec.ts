import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The menu panel (`.popover-ui`), the tooltip (`.tooltip`) and the tab trigger (`rounded-theme-tab`)
 * take their corners from the `menuRadius`, `tooltipRadius` and `tabRadius` roles. Their defaults
 * are the literals they drew before, so the default theme is unchanged in both modes, and the
 * ClickHouse theme rounds all three at Click UI's 0.25rem.
 */

type Mode = 'light' | 'dark';

const PROBES = ['popover-ui', 'tooltip', 'rounded-theme-tab'] as const;

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

async function corners(page: Page): Promise<string[]> {
  const values: string[] = [];
  for (const classes of PROBES) {
    values.push(await probeStyle(page, classes, 'border-top-left-radius'));
  }
  return values;
}

test.describe('menu, tooltip and tab corners', () => {
  test('the default theme keeps its menu, tooltip and tab corners in both modes @scenario:corner-roles-default-unchanged', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode);

      expect(await corners(modePage)).toEqual(['11.2px', '4.4px', '2.96px']);
    }
  });

  test('the ClickHouse theme rounds menus, tooltips and tabs at Click UI corners in both modes @scenario:corner-roles-clickhouse', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, clickHouseTheme);

      expect(await corners(modePage)).toEqual(['4px', '4px', '4px']);
    }
  });
});
