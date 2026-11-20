import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The chrome and inset border roles. `border-chrome` outlines the controls and chips that sit on
 * the shell and `border-inset` draws the hairlines inside a surface that is already stroked; both
 * are `border-light` at the `chromeBorderAlpha` and `insetBorderAlpha` shares, 1 by default, so the
 * bundled palettes draw them as they always drew `border-light`. ClickHouse sets both to 0, as
 * Click UI strokes neither, and a reference theme proves each role follows its own alpha.
 */

type Mode = 'light' | 'dark';
type Borders = { chrome: string; inset: string };

const QUIET_THEME = {
  version: 1,
  name: 'e2e-border-share',
  modes: {
    light: {
      colors: { 'rgb-border-light': '10 20 30' },
      appearance: { chromeBorderAlpha: '0.25', insetBorderAlpha: '0.5' },
    },
    dark: {
      colors: { 'rgb-border-light': '10 20 30' },
      appearance: { chromeBorderAlpha: '0.25', insetBorderAlpha: '0.5' },
    },
  },
} as const;

async function openChat(page: Page, mode: Mode, definition?: { name: string }) {
  await page.addInitScript(
    ([appearance, stored]) => {
      localStorage.setItem('color-theme', appearance as string);
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
  const root = page.locator('html');
  if (definition) {
    await expect(root).toHaveAttribute('data-theme', definition.name);
  } else {
    await expect(root).not.toHaveAttribute('data-theme');
  }
  await expect(root).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
}

function borders(page: Page): Promise<Borders> {
  return page.evaluate(() => {
    const paint = (className: string) => {
      const node = document.createElement('div');
      node.className = `border border-solid ${className}`;
      document.body.append(node);
      const style = getComputedStyle(node);
      const color = style.borderTopColor;
      const width = style.borderTopWidth;
      node.remove();
      return `${color} ${width}`;
    };
    return { chrome: paint('border-border-chrome'), inset: paint('border-border-inset') };
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{
  title: string;
  mode: Mode;
  definition?: { name: string };
  expected: Borders;
}> = [
  {
    title:
      'the default light theme draws chrome and inset borders as border-light @scenario:chrome-border-default-light-unchanged',
    mode: 'light',
    expected: { chrome: 'rgb(227, 227, 227) 1px', inset: 'rgb(227, 227, 227) 1px' },
  },
  {
    title:
      'the default dark theme draws chrome and inset borders as border-light @scenario:chrome-border-default-dark-unchanged',
    mode: 'dark',
    expected: { chrome: 'rgb(33, 33, 33) 1px', inset: 'rgb(33, 33, 33) 1px' },
  },
  {
    title:
      'the ClickHouse light theme draws no chrome or inset border and keeps the 1px box @scenario:chrome-border-clickhouse-light',
    mode: 'light',
    definition: clickHouseTheme,
    expected: { chrome: 'rgba(230, 231, 233, 0) 1px', inset: 'rgba(230, 231, 233, 0) 1px' },
  },
  {
    title:
      'the ClickHouse dark theme draws no chrome or inset border and keeps the 1px box @scenario:chrome-border-clickhouse-dark',
    mode: 'dark',
    definition: clickHouseTheme,
    expected: { chrome: 'rgba(50, 50, 50, 0) 1px', inset: 'rgba(50, 50, 50, 0) 1px' },
  },
  {
    title:
      'a theme that sets the border shares draws chrome and inset at their own share @scenario:chrome-border-follow-reference-theme',
    mode: 'light',
    definition: QUIET_THEME,
    expected: { chrome: 'rgba(10, 20, 30, 0.25) 1px', inset: 'rgba(10, 20, 30, 0.5) 1px' },
  },
];

test.describe('chrome and inset border roles', () => {
  for (const { title, mode, definition, expected } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      expect(await borders(page)).toEqual(expected);
    });
  }
});
