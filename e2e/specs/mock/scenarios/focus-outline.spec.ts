import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The app-wide keyboard focus outline. The default light and dark themes draw it in black and
 * white, a theme definition that names its own `ring-primary` draws it in that ring, one that
 * leaves the ring to the default keeps black and white, and the contrast modes keep their heavier
 * text-colored outline. The probe is a bare button reached with Tab, so nothing but the
 * global rule styles its outline.
 */

type Appearance = 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';
type Outline = { color: string; style: string; width: string; offset: string };

const PROBE = 'focus-outline-probe';

const CUSTOM_RING_THEME = {
  version: 1,
  name: 'e2e-focus-ring',
  modes: {
    light: { colors: { 'rgb-ring-primary': '10 20 30' } },
    dark: { colors: { 'rgb-ring-primary': '200 210 220' } },
  },
} as const;

/** Leaves `rgb-ring-primary` to the default, which resolves to a gray too dim for a dark surface. */
const RINGLESS_THEME = {
  version: 1,
  name: 'e2e-ringless',
  modes: {
    light: { colors: { 'rgb-accent-primary': '10 20 30' } },
    dark: { colors: { 'rgb-accent-primary': '200 210 220' } },
  },
} as const;

async function installAppearance(page: Page, appearance: Appearance, definition?: unknown) {
  await page.addInitScript(
    ([mode, stored]) => {
      localStorage.setItem('color-theme', mode as string);
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
    [appearance, definition ?? null] as [string, unknown],
  );
}

/**
 * Tabs onto a bare button and reads the outline it draws. Tab moves on from the focused element,
 * so a sentinel that takes script focus but sits outside the tab order anchors the move.
 */
async function keyboardFocusOutline(page: Page): Promise<Outline> {
  await page.evaluate((id) => {
    const sentinel = document.createElement('span');
    sentinel.tabIndex = -1;
    const probe = document.createElement('button');
    probe.id = id;
    probe.textContent = 'Focus probe';
    document.body.prepend(sentinel, probe);
    sentinel.focus();
  }, PROBE);
  await page.keyboard.press('Tab');

  const probe = page.locator(`#${PROBE}`);
  await expect(probe).toBeFocused();
  expect(await probe.evaluate((node) => node.matches(':focus-visible'))).toBe(true);

  return probe.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      width: style.outlineWidth,
      offset: style.outlineOffset,
    };
  });
}

async function openChat(page: Page, appearance: Appearance, definition?: { name: string }) {
  await installAppearance(page, appearance, definition);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  const root = page.locator('html');
  if (appearance.startsWith('high-contrast')) {
    await expect(root).toHaveClass(/\bhigh-contrast\b/);
  } else if (definition) {
    await expect(root).toHaveAttribute('data-theme', definition.name);
  } else {
    await expect(root).not.toHaveAttribute('data-theme');
  }
  await expect(root).toHaveClass(appearance.endsWith('dark') ? /\bdark\b/ : /\blight\b/);
}

const outline = (color: string, width = '2px'): Outline => ({
  color,
  style: 'solid',
  width,
  offset: '2px',
});

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{
  title: string;
  appearance: Appearance;
  definition?: { name: string };
  expected: Outline;
}> = [
  {
    title:
      'the default light theme keeps its black focus outline @scenario:focus-outline-default-light-unchanged',
    appearance: 'light',
    expected: outline('rgb(0, 0, 0)'),
  },
  {
    title:
      'the default dark theme keeps its white focus outline @scenario:focus-outline-default-dark-unchanged',
    appearance: 'dark',
    expected: outline('rgb(255, 255, 255)'),
  },
  {
    title:
      'the ClickHouse light theme draws focus in its outline blue @scenario:focus-outline-follows-clickhouse-ring-light',
    appearance: 'light',
    definition: clickHouseTheme,
    expected: outline('rgb(67, 126, 239)'),
  },
  {
    title:
      'the ClickHouse dark theme draws focus in its brand yellow @scenario:focus-outline-follows-clickhouse-ring-dark',
    appearance: 'dark',
    definition: clickHouseTheme,
    expected: outline('rgb(250, 255, 105)'),
  },
  {
    title:
      'a dark theme that leaves the ring to the default keeps the white focus outline @scenario:focus-outline-ringless-theme-keeps-default',
    appearance: 'dark',
    definition: RINGLESS_THEME,
    expected: outline('rgb(255, 255, 255)'),
  },
  {
    title:
      'high contrast light keeps its heavy text-colored focus outline @scenario:focus-outline-high-contrast-light-unchanged',
    appearance: 'high-contrast-light',
    definition: clickHouseTheme,
    expected: outline('rgb(0, 0, 0)', '3px'),
  },
  {
    title:
      'high contrast dark keeps its heavy text-colored focus outline @scenario:focus-outline-high-contrast-dark-unchanged',
    appearance: 'high-contrast-dark',
    definition: clickHouseTheme,
    expected: outline('rgb(255, 255, 255)', '3px'),
  },
];

test.describe('keyboard focus outline', () => {
  for (const { title, appearance, definition, expected } of CASES) {
    test(title, async ({ page }) => {
      await openChat(page, appearance, definition);

      expect(await keyboardFocusOutline(page)).toEqual(expected);
    });
  }

  test('a custom theme draws focus in the ring it defines, in both modes @scenario:focus-outline-follows-custom-theme-ring', async ({
    page,
  }) => {
    const rings: Record<'light' | 'dark', string> = {
      light: 'rgb(10, 20, 30)',
      dark: 'rgb(200, 210, 220)',
    };
    /** One page per mode: a page's init scripts accumulate, and their order is not guaranteed. */
    for (const mode of ['light', 'dark'] as const) {
      const modePage = mode === 'light' ? page : await page.context().newPage();
      await openChat(modePage, mode, CUSTOM_RING_THEME);

      expect(await keyboardFocusOutline(modePage)).toEqual(outline(rings[mode]));
    }
  });
});
