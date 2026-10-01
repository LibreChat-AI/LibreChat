import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The shared menu panel (`.popover-ui`) draws its light shadow from the `shadowLg` role, whose
 * default is the literal it drew before, so the default theme is unchanged and the ClickHouse
 * theme takes Click UI's `genericMenu.panel.shadow.default`. The dark panel keeps the app's own
 * literal in every theme (berry-13/LibreChat#217).
 */

type Mode = 'light' | 'dark';

const DEFAULT_LIGHT = 'rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px';
const DARK = 'rgba(0, 0, 0, 0.25) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px';
const CLICKHOUSE_LIGHT =
  'rgba(21, 21, 21, 0.15) 0px 4px 6px -1px, rgba(21, 21, 21, 0.15) 0px 2px 4px -1px';

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

const CASES: Array<{ title: string; mode: Mode; definition?: { name: string }; shadow: string }> = [
  {
    title:
      'the default light menu panel keeps its shadow @scenario:menu-shadow-default-light-unchanged',
    mode: 'light',
    shadow: DEFAULT_LIGHT,
  },
  {
    title:
      'the default dark menu panel keeps its shadow @scenario:menu-shadow-default-dark-unchanged',
    mode: 'dark',
    shadow: DARK,
  },
  {
    title:
      'the ClickHouse light menu panel takes the Click UI menu shadow @scenario:menu-shadow-clickhouse-light',
    mode: 'light',
    definition: clickHouseTheme,
    shadow: CLICKHOUSE_LIGHT,
  },
  {
    title:
      'the ClickHouse dark menu panel keeps the app dark shadow @scenario:menu-shadow-clickhouse-dark-unchanged',
    mode: 'dark',
    definition: clickHouseTheme,
    shadow: DARK,
  },
];

test.describe('menu panel shadow', () => {
  for (const { title, mode, definition, shadow } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      expect(await probeStyle(page, 'popover-ui', 'box-shadow')).toBe(shadow);
    });
  }
});
