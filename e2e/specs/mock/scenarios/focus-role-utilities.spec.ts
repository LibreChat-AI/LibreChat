import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The focus outline utilities the primitives compose (`outline-theme-focus`,
 * `outline-offset-theme-focus`, `outline-focus-outline`) paint what the global `:focus-visible`
 * rule paints, in every palette and at the theme's width and offset, so a primitive that names the
 * outline itself reads as it did when it inherited it. A probe carries the class string
 * `focusOutlineRole` exports, and the settings theme selector is the real Dropdown trigger.
 */

type Mode = 'light' | 'dark';

const ROLE_CLASSES =
  'focus-visible:outline-theme-focus focus-visible:outline-offset-theme-focus focus-visible:outline-focus-outline';

const SIZE_THEME = {
  version: 1,
  name: 'e2e-focus-role-size',
  modes: {
    light: { appearance: { focusRingWidth: '3px', focusRingOffset: '1px' } },
    dark: { appearance: { focusRingWidth: '4px', focusRingOffset: '0' } },
  },
} as const;

const NAMED_THEME = {
  version: 1,
  name: 'e2e-focus-role-named',
  modes: {
    light: { colors: { 'rgb-focus-outline': '180 0 110' } },
    dark: { colors: { 'rgb-focus-outline': '255 140 200' } },
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

/** Tabs onto a button carrying `classes` and reads its outline. */
async function outlineOf(page: Page, id: string, classes: string) {
  await page.evaluate(
    ([probeId, className]) => {
      const sentinel = document.createElement('span');
      sentinel.tabIndex = -1;
      const probe = document.createElement('button');
      probe.id = probeId;
      probe.className = className;
      probe.textContent = 'Probe';
      document.body.prepend(sentinel, probe);
      sentinel.focus();
    },
    [id, classes],
  );
  await page.keyboard.press('Tab');
  const probe = page.locator(`#${id}`);
  await expect(probe).toBeFocused();
  return probe.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset];
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{ title: string; mode: Mode; definition?: { name: string }; width?: string }> = [
  {
    title:
      'the focus outline utilities match the global outline in the default light theme @scenario:focus-role-utilities-default-light',
    mode: 'light',
  },
  {
    title:
      'the focus outline utilities match the global outline in the default dark theme @scenario:focus-role-utilities-default-dark',
    mode: 'dark',
  },
  {
    title:
      'the focus outline utilities match the global outline in ClickHouse light @scenario:focus-role-utilities-clickhouse-light',
    mode: 'light',
    definition: clickHouseTheme,
  },
  {
    title:
      'the focus outline utilities match the global outline in ClickHouse dark @scenario:focus-role-utilities-clickhouse-dark',
    mode: 'dark',
    definition: clickHouseTheme,
  },
  {
    title:
      'the focus outline utilities follow a theme that names the outline color @scenario:focus-role-utilities-named-color-dark',
    mode: 'dark',
    definition: NAMED_THEME,
  },
  {
    title:
      'the focus outline utilities follow the theme width and offset in light @scenario:focus-role-utilities-size-light',
    mode: 'light',
    definition: SIZE_THEME,
    width: '3px',
  },
  {
    title:
      'the focus outline utilities follow the theme width and offset in dark @scenario:focus-role-utilities-size-dark',
    mode: 'dark',
    definition: SIZE_THEME,
    width: '4px',
  },
];

test.describe('focus outline utilities', () => {
  for (const { title, mode, definition, width } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, mode, definition);

      const global = await outlineOf(page, 'focus-role-bare', '');
      const role = await outlineOf(page, 'focus-role-utilities', ROLE_CLASSES);

      expect(global[0]).toBe('solid');
      expect(role).toEqual(global);

      /** The real non-field Dropdown trigger, with the classes the primitive ships. */
      await page.getByTestId('nav-user').click();
      await page.getByRole('menuitem', { name: 'Settings' }).click();
      const trigger = page.getByTestId('theme-selector');
      await expect(trigger).toBeVisible({ timeout: 10000 });
      await page.keyboard.press('Shift');
      await trigger.focus();
      await expect(trigger).toBeFocused();
      expect(await trigger.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
      expect(
        await trigger.evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset];
        }),
      ).toEqual(global);
      if (width) {
        expect(role[1]).toBe(width);
      }
    });
  }
});
