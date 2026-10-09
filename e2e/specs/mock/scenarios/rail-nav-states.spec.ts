import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The desktop icon rail marks its current panel and the one under the pointer with the theme's
 * navigation roles, the same layers the sidebar rows use, so a theme that sets them apart from
 * the generic hover and active fills paints the rail with them too.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

type Mode = 'light' | 'dark';

type ThemeChoice = 'clickhouse' | 'default';

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

const fill = (locator: Locator) =>
  locator.evaluate((node) => getComputedStyle(node).backgroundColor);

async function openRail(page: Page, theme: ThemeChoice, mode: Mode) {
  await page.goto(`${NEW_CHAT_PATH}?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
  const selected = page.locator('[data-testid^="nav-panel-"][aria-pressed="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeVisible();
  const idleId = await page
    .locator('[data-testid^="nav-panel-"][aria-pressed="false"]')
    .first()
    .getAttribute('data-testid');
  const idle = page.getByTestId(idleId ?? '');
  await expect(idle).toBeVisible();
  return { selected, idle };
}

test.describe('desktop icon rail', () => {
  test('the rail paints its selected and hovered destinations with the navigation roles under the ClickHouse theme @scenario:rail-nav-roles-clickhouse', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const mode of ['light', 'dark'] as Mode[]) {
      const { selected, idle } = await openRail(page, 'clickhouse', mode);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};

      await expect(selected).toHaveAttribute('data-testid', 'nav-panel-conversations');
      await expect.poll(() => fill(selected)).toBe(rgb(colors['rgb-surface-nav-selected']));
      expect(rgb(colors['rgb-surface-nav-selected'])).not.toBe(
        rgb(colors['rgb-surface-active-alt']),
      );

      await idle.focus();
      expect(await idle.evaluate((node) => node.matches(':focus-visible'))).toBe(true);
      await expect
        .poll(() => idle.evaluate((node) => getComputedStyle(node).boxShadow))
        .not.toBe('none');

      await idle.hover();
      await expect.poll(() => fill(idle)).toBe(rgb(colors['rgb-surface-nav-hover']));

      await page.mouse.move(640, 400);
      await expect.poll(() => fill(idle)).toBe('rgba(0, 0, 0, 0)');
    }
  });

  test('the default theme keeps the rail selected and hovered fills @scenario:rail-nav-default-unchanged', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const [mode, active] of [
      ['light', 'rgb(227, 227, 227)'],
      ['dark', 'rgb(47, 47, 47)'],
    ] as Array<[Mode, string]>) {
      const { selected, idle } = await openRail(page, 'default', mode);

      await expect.poll(() => fill(selected)).toBe(active);
      await idle.hover();
      await expect.poll(() => fill(idle)).toBe(active);

      await idle.click();
      await expect(idle).toHaveAttribute('aria-pressed', 'true');
      await expect(selected).toHaveCount(1);
    }
  });
});
