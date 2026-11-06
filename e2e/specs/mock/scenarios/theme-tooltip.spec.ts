import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The tooltip reads its chip, label, padding and text size from theme roles. Click UI draws a dark
 * chip with a white 12px label in 8px 12px padding in both modes; LibreChat's own tooltip is the
 * page surface with the page ink, 16px text and 4px 8px padding, and stays that way without a theme.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';

type ThemeChoice = 'clickhouse' | 'default';

/**
 * One init script per page: Playwright does not order several, so the theme and mode a
 * navigation wants ride in its URL and the script stores or clears the definition.
 */
async function installThemeBridge(page: Page) {
  await page.addInitScript((definition) => {
    const params = new URL(location.href).searchParams;
    const theme = params.get('e2eTheme');
    const mode = params.get('e2eThemeMode');
    if (theme === null || mode === null) {
      return;
    }
    localStorage.setItem('color-theme', mode);
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (theme === 'clickhouse') {
      localStorage.setItem('theme-definition', JSON.stringify(definition));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, clickHouseTheme);
}

const rgb = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

async function openTooltip(page: Page, theme: ThemeChoice, mode: Mode) {
  await page.goto(`${NEW_CHAT_PATH}?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
  await page.getByTestId('new-chat-button').hover();
  const tooltip = page.locator('.tooltip');
  await expect(tooltip).toBeVisible({ timeout: 10000 });
  return tooltip.evaluate((node: HTMLElement) => {
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      color: style.color,
      padding: [style.paddingTop, style.paddingRight],
      fontSize: style.fontSize,
    };
  });
}

test.describe('theme tooltip', () => {
  test('the tooltip takes the Click UI chip under the ClickHouse theme @scenario:clickhouse-tooltip-follows-click-ui', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const mode of ['light', 'dark'] as Mode[]) {
      const colors = clickHouseTheme.modes[mode]?.colors;
      expect(await openTooltip(page, 'clickhouse', mode)).toEqual({
        background: rgb(colors?.['rgb-surface-tooltip']),
        color: rgb(colors?.['rgb-text-tooltip']),
        padding: ['8px', '12px'],
        fontSize: '12px',
      });
    }
  });

  test('the default theme keeps its tooltip @scenario:default-theme-tooltip-unchanged', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const [mode, background, color] of [
      ['light', 'rgb(255, 255, 255)', 'rgb(33, 33, 33)'],
      ['dark', 'rgb(13, 13, 13)', 'rgb(236, 236, 236)'],
    ] as Array<[Mode, string, string]>) {
      expect(await openTooltip(page, 'default', mode)).toEqual({
        background,
        color,
        padding: ['4px', '8px'],
        fontSize: '16px',
      });
    }
  });
});
