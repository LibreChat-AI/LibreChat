import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { darkTheme } from '../../../../packages/client/src/theme/themes/dark';
import { themeValue } from './style.helpers';

/**
 * A form control's outline is the only edge it has. The stock light and dark
 * palettes keep it at their quiet light border, and the high contrast and
 * ClickHouse palettes hold it to the WCAG 1.4.11 3:1 non-text floor against
 * whatever the control is painted on. The probe is a real control, the week
 * start `Dropdown` in the settings dialog, measured against the first opaque
 * surface behind it.
 */

type Rgb = [number, number, number];
type Appearance = 'light' | 'dark' | 'high-contrast-light' | 'high-contrast-dark';

const WCAG_NON_TEXT = 3;
const TRIGGER = '[data-testid="week-start-selector"]';

test.use({ viewport: { width: 1280, height: 800 } });

async function installAppearance(page: Page, appearance: Appearance, definition?: unknown) {
  await page.addInitScript(
    ([mode, stored]) => {
      localStorage.setItem('color-theme', mode as string);
      localStorage.setItem('navVisible', 'true');
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

function parseRgb(value: string): Rgb {
  const channels = value.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  return [channels[0], channels[1], channels[2]];
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function contrast(a: Rgb, b: Rgb): number {
  const luminance = ([r, g, b]: Rgb) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

async function openSettings(page: Page) {
  await page.goto('/c/new');
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.locator(TRIGGER)).toBeVisible({ timeout: 10000 });
}

/** The trigger's border colour and the first opaque background behind it. */
function outlineAgainstSurface(page: Page): Promise<{ border: string; surface: string }> {
  return page.locator(TRIGGER).evaluate((node) => {
    const border = getComputedStyle(node).borderTopColor;
    for (let el: Element | null = node.parentElement; el; el = el.parentElement) {
      const background = getComputedStyle(el).backgroundColor;
      if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
        return { border, surface: background };
      }
    }
    return { border, surface: getComputedStyle(document.body).backgroundColor };
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const PALETTES: Array<{
  name: string;
  tag: string;
  appearance: Appearance;
  definition?: unknown;
}> = [
  {
    name: 'high contrast light',
    tag: '@scenario:control-outline-clears-3-to-1-high-contrast-light',
    appearance: 'high-contrast-light',
  },
  {
    name: 'high contrast dark',
    tag: '@scenario:control-outline-clears-3-to-1-high-contrast-dark',
    appearance: 'high-contrast-dark',
  },
  {
    name: 'clickhouse light',
    tag: '@scenario:control-outline-clears-3-to-1-clickhouse-light',
    appearance: 'light',
    definition: clickHouseTheme,
  },
  {
    name: 'clickhouse dark',
    tag: '@scenario:control-outline-clears-3-to-1-clickhouse-dark',
    appearance: 'dark',
    definition: clickHouseTheme,
  },
];

test.describe('form control outline', () => {
  for (const palette of PALETTES) {
    test(`a dropdown outline clears 3:1 in the ${palette.name} palette ${palette.tag}`, async ({
      page,
    }) => {
      await installAppearance(page, palette.appearance, palette.definition);
      await openSettings(page);

      const { border, surface } = await outlineAgainstSurface(page);
      const ratio = contrast(parseRgb(border), parseRgb(surface));

      expect({ border, surface, clears: ratio >= WCAG_NON_TEXT }).toEqual({
        border,
        surface,
        clears: true,
      });
    });
  }

  test('dark separators keep their quiet step while controls take their own role @scenario:dark-separators-stay-quiet', async ({
    page,
  }) => {
    await installAppearance(page, 'dark');
    await openSettings(page);

    expect(await themeValue(page, '--border-light')).toBe(darkTheme['rgb-border-light']);
    expect(await themeValue(page, '--border-medium')).toBe(darkTheme['rgb-border-medium']);
    expect(await themeValue(page, '--border-control')).toBe(darkTheme['rgb-border-control']);
  });

  test('a custom theme without the control role keeps the outline it drew @scenario:custom-theme-keeps-its-control-outline', async ({
    page,
  }) => {
    const definition = {
      version: 1,
      name: 'legacy-outline',
      modes: { light: { colors: { 'rgb-border-light': '70 90 110' } } },
    };
    await installAppearance(page, 'light', definition);
    await openSettings(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'legacy-outline');
    expect(await themeValue(page, '--border-control')).toBe('70 90 110');
    expect((await outlineAgainstSurface(page)).border).toBe('rgb(70, 90, 110)');
  });
});
