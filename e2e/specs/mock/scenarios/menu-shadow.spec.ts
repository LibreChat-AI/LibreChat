import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The shared menu panel (`.popover-ui`) and tooltip (`.tooltip`) draw their shadows from the
 * `menuShadow` and `tooltipShadow` roles, whose light and dark defaults are the literals each mode
 * drew before, so the default theme is unchanged. The ClickHouse theme takes Click UI's
 * `genericMenu.panel.shadow.default` in each mode and draws tooltips with no shadow, and a theme
 * that names only `shadowLg` keeps shading its light menus with it, as it did before the role.
 */

type Mode = 'light' | 'dark';

const DEFAULT_LIGHT = 'rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px';
const DARK = 'rgba(0, 0, 0, 0.25) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px';
const CLICKHOUSE_LIGHT =
  'rgba(21, 21, 21, 0.15) 0px 4px 6px -1px, rgba(21, 21, 21, 0.15) 0px 2px 4px -1px';
const CLICKHOUSE_DARK =
  'rgba(21, 21, 21, 0.6) 0px 4px 6px -1px, rgba(21, 21, 21, 0.6) 0px 2px 4px -1px';
const TOOLTIP_LIGHT = 'rgba(0, 0, 0, 0.25) 0px 2px 4px 0px';
const TOOLTIP_DARK = 'rgba(0, 0, 0, 0.35) 0px 1px 2px 0px';

/** Names only the general large shadow, the way a theme written before the menu role would. */
const LG_ONLY_THEME = {
  version: 1,
  name: 'e2e-shadow-lg-only',
  modes: {
    light: { appearance: { shadowLg: '0 1px 2px 0 rgb(10 20 30 / 0.5)' } },
    dark: { appearance: { shadowLg: '0 1px 2px 0 rgb(10 20 30 / 0.5)' } },
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

type Shadows = { menu: string; tooltip: string };

const CASES: Array<{ title: string; mode: Mode; definition?: { name: string }; shadows: Shadows }> =
  [
    {
      title:
        'the default light menu panel and tooltip keep their shadows @scenario:menu-shadow-default-light-unchanged',
      mode: 'light',
      shadows: { menu: DEFAULT_LIGHT, tooltip: TOOLTIP_LIGHT },
    },
    {
      title:
        'the default dark menu panel and tooltip keep their shadows @scenario:menu-shadow-default-dark-unchanged',
      mode: 'dark',
      shadows: { menu: DARK, tooltip: TOOLTIP_DARK },
    },
    {
      title:
        'the ClickHouse light theme takes the Click UI menu shadow and drops the tooltip shadow @scenario:menu-shadow-clickhouse-light',
      mode: 'light',
      definition: clickHouseTheme,
      shadows: { menu: CLICKHOUSE_LIGHT, tooltip: 'none' },
    },
    {
      title:
        'the ClickHouse dark theme takes the Click UI menu shadow and drops the tooltip shadow @scenario:menu-shadow-clickhouse-dark',
      mode: 'dark',
      definition: clickHouseTheme,
      shadows: { menu: CLICKHOUSE_DARK, tooltip: 'none' },
    },
    {
      title:
        'a light theme that names only shadowLg still shades its menus with it @scenario:menu-shadow-follows-shadow-lg-light',
      mode: 'light',
      definition: LG_ONLY_THEME,
      shadows: { menu: 'rgba(10, 20, 30, 0.5) 0px 1px 2px 0px', tooltip: TOOLTIP_LIGHT },
    },
    {
      title:
        'a dark theme that names only shadowLg keeps the dark menu literal @scenario:menu-shadow-shadow-lg-dark-unchanged',
      mode: 'dark',
      definition: LG_ONLY_THEME,
      shadows: { menu: DARK, tooltip: TOOLTIP_DARK },
    },
  ];

test.describe('menu panel and tooltip shadows', () => {
  for (const { title, mode, definition, shadows } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      expect({
        menu: await probeStyle(page, 'popover-ui', 'box-shadow'),
        tooltip: await probeStyle(page, 'tooltip', 'box-shadow'),
      }).toEqual(shadows);
    });
  }
});
