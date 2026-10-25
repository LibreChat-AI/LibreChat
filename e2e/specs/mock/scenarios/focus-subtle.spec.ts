import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The subtle focus role. Rows and controls inside content (tool rows, attachments, summaries,
 * message navigation) ring their keyboard focus in `focus-subtle`, which follows `border-heavy`
 * unless a theme names it, so the bundled palettes keep the ring they had. ClickHouse takes Click
 * UI's outline color, and a theme that only repaints `border-heavy` keeps its rows on it.
 */

type Mode = 'light' | 'dark';

const HEAVY_ONLY_THEME = {
  version: 1,
  name: 'e2e-focus-subtle-heavy',
  modes: {
    light: { colors: { 'rgb-border-heavy': '10 20 30' } },
    dark: { colors: { 'rgb-border-heavy': '10 20 30' } },
  },
} as const;

const NAMED_THEME = {
  version: 1,
  name: 'e2e-focus-subtle-named',
  modes: {
    light: { colors: { 'rgb-border-heavy': '10 20 30', 'rgb-focus-subtle': '200 30 90' } },
    dark: { colors: { 'rgb-border-heavy': '10 20 30', 'rgb-focus-subtle': '200 30 90' } },
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

/**
 * The ring the utility paints on focus. The ring colour is read from the utility's own custom
 * property, because the dark stylesheet's `.dark :focus-visible` outline rule outranks any outline
 * utility and would hide the role.
 */
function subtleFocus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = document.createElement('div');
    node.className = 'focus-visible:ring-focus-subtle';
    node.tabIndex = -1;
    document.body.append(node);
    node.focus();
    const ring = getComputedStyle(node).getPropertyValue('--tw-ring-color');
    node.remove();
    const channels = ring.match(/\d+/g) ?? [];
    return `rgb(${channels.slice(0, 3).join(', ')})`;
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{ title: string; mode: Mode; definition?: { name: string }; expected: string }> =
  [
    {
      title:
        'the default light theme keeps the heavy border as its subtle focus ring @scenario:focus-subtle-default-light-unchanged',
      mode: 'light',
      expected: 'rgb(153, 150, 150)',
    },
    {
      title:
        'the default dark theme keeps the heavy border as its subtle focus ring @scenario:focus-subtle-default-dark-unchanged',
      mode: 'dark',
      expected: 'rgb(89, 89, 89)',
    },
    {
      title:
        'the ClickHouse light theme rings subtle focus in the Click UI outline @scenario:focus-subtle-clickhouse-light',
      mode: 'light',
      definition: clickHouseTheme,
      expected: 'rgb(67, 126, 239)',
    },
    {
      title:
        'the ClickHouse dark theme rings subtle focus in the Click UI outline @scenario:focus-subtle-clickhouse-dark',
      mode: 'dark',
      definition: clickHouseTheme,
      expected: 'rgb(250, 255, 105)',
    },
    {
      title:
        'a theme that repaints only the heavy border keeps its subtle focus on it @scenario:focus-subtle-follows-heavy-border',
      mode: 'light',
      definition: HEAVY_ONLY_THEME,
      expected: 'rgb(10, 20, 30)',
    },
    {
      title:
        'a theme that names the subtle focus role rings in it whatever the heavy border is @scenario:focus-subtle-follow-reference-theme',
      mode: 'light',
      definition: NAMED_THEME,
      expected: 'rgb(200, 30, 90)',
    },
  ];

test.describe('subtle focus role', () => {
  for (const { title, mode, definition, expected } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      expect(await subtleFocus(page)).toBe(expected);
    });
  }
});
