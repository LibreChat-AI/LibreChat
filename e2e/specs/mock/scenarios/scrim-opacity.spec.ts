import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The dialog scrims' opacity roles. OGDialog, AlertDialog and Dialog lay `surface-overlay` over the
 * page at `scrimOpacity`, `alertScrimOpacity` and `modalScrimOpacity`, which default to the 80%,
 * 90% and 65% the families always drew. ClickHouse takes Click UI's 0.75 for all three, and a
 * reference theme proves each family follows its own role. The probes carry the scrim classes
 * the three overlays compose, so only the roles style them.
 */

type Mode = 'light' | 'dark';
type Scrims = { dialog: string; alert: string; modal: string };

const REFERENCE_THEME = {
  version: 1,
  name: 'e2e-scrim-opacity',
  modes: {
    light: {
      colors: { 'rgb-surface-overlay': '10 20 30' },
      appearance: { scrimOpacity: '0.5', alertScrimOpacity: '0.6', modalScrimOpacity: '0.7' },
    },
    dark: {
      colors: { 'rgb-surface-overlay': '10 20 30' },
      appearance: { scrimOpacity: '0.5', alertScrimOpacity: '0.6', modalScrimOpacity: '0.7' },
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

function scrims(page: Page): Promise<Scrims> {
  return page.evaluate(() => {
    const fill = (className: string) => {
      const node = document.createElement('div');
      node.className = className;
      document.body.append(node);
      const color = getComputedStyle(node).backgroundColor;
      node.remove();
      return color;
    };
    return {
      dialog: fill('bg-scrim'),
      alert: fill('bg-scrim-alert'),
      modal: fill('bg-scrim-modal'),
    };
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{ title: string; mode: Mode; definition?: { name: string }; expected: Scrims }> =
  [
    {
      title:
        'the default light theme keeps each dialog family scrim @scenario:scrim-opacity-default-light-unchanged',
      mode: 'light',
      expected: {
        dialog: 'rgba(89, 89, 89, 0.8)',
        alert: 'rgba(89, 89, 89, 0.9)',
        modal: 'rgba(89, 89, 89, 0.65)',
      },
    },
    {
      title:
        'the default dark theme keeps each dialog family scrim @scenario:scrim-opacity-default-dark-unchanged',
      mode: 'dark',
      expected: {
        dialog: 'rgba(0, 0, 0, 0.8)',
        alert: 'rgba(0, 0, 0, 0.9)',
        modal: 'rgba(0, 0, 0, 0.65)',
      },
    },
    {
      title:
        'the ClickHouse light theme dims at Click UI scrim opacity @scenario:scrim-opacity-clickhouse-light',
      mode: 'light',
      definition: clickHouseTheme,
      expected: {
        dialog: 'rgba(21, 21, 21, 0.75)',
        alert: 'rgba(21, 21, 21, 0.75)',
        modal: 'rgba(21, 21, 21, 0.75)',
      },
    },
    {
      title:
        'the ClickHouse dark theme dims at Click UI scrim opacity without lifting the page @scenario:scrim-opacity-clickhouse-dark',
      mode: 'dark',
      definition: clickHouseTheme,
      expected: {
        dialog: 'rgba(0, 0, 0, 0.75)',
        alert: 'rgba(0, 0, 0, 0.75)',
        modal: 'rgba(0, 0, 0, 0.75)',
      },
    },
    {
      title:
        'a theme that names the scrim roles dims each dialog family by its own @scenario:scrim-opacity-follow-reference-theme',
      mode: 'light',
      definition: REFERENCE_THEME,
      expected: {
        dialog: 'rgba(10, 20, 30, 0.5)',
        alert: 'rgba(10, 20, 30, 0.6)',
        modal: 'rgba(10, 20, 30, 0.7)',
      },
    },
  ];

test.describe('dialog scrim opacity roles', () => {
  for (const { title, mode, definition, expected } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      expect(await scrims(page)).toEqual(expected);
    });
  }
});
