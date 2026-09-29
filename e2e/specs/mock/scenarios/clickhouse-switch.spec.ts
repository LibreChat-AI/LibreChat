import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The shared switch reads its track size and its knob from theme roles. Click UI draws a 32x16
 * track with a 12px knob that is white in light mode and `#151515` in dark; LibreChat's own switch
 * is 44x24 with a 20px knob on `surface-primary`, and stays that way without a theme.
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

async function settingsSwitch(page: Page, theme: ThemeChoice, mode: Mode): Promise<Locator> {
  await page.goto(`${NEW_CHAT_PATH}?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: 'General' }).click();
  const control = dialog.getByRole('switch').first();
  await expect(control).toBeVisible();
  return control;
}

/** What takes a tap: the track's own box together with the invisible layer centered on it. */
const hitArea = (control: Locator) =>
  control.evaluate((node: HTMLElement) => {
    const layer = getComputedStyle(node, '::before');
    return {
      width: Math.max(node.offsetWidth, parseFloat(layer.width)),
      height: Math.max(node.offsetHeight, parseFloat(layer.height)),
      coarse: matchMedia('(any-pointer: coarse)').matches,
    };
  });

async function measure(control: Locator) {
  /** Layout sizes, not client rects: the dialog is still zooming in when this reads. */
  return control.evaluate((node: HTMLElement) => {
    const thumb = node.firstElementChild as HTMLElement;
    return {
      track: [node.offsetWidth, node.offsetHeight],
      thumb: thumb.offsetWidth,
      thumbColor: getComputedStyle(thumb).backgroundColor,
    };
  });
}

const rgb = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

test.describe('theme switch', () => {
  test('the switch takes Click UI geometry and knob color under the ClickHouse theme @scenario:clickhouse-switch-follows-click-ui', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const mode of ['light', 'dark'] as Mode[]) {
      const control = await settingsSwitch(page, 'clickhouse', mode);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));

      const knob = clickHouseTheme.modes[mode]?.colors?.['rgb-switch-thumb'];
      expect(await measure(control)).toEqual({
        track: [32, 16],
        thumb: 12,
        thumbColor: rgb(knob),
      });
      const hit = await hitArea(control);
      const floor = hit.coarse ? 44 : 24;
      expect(hit.height).toBeGreaterThanOrEqual(floor);
      expect(hit.width).toBeGreaterThanOrEqual(floor);
    }
  });

  test('the default theme keeps its switch @scenario:default-theme-switch-unchanged', async ({
    page,
  }) => {
    await installThemeBridge(page);
    for (const [mode, surface] of [
      ['light', 'rgb(255, 255, 255)'],
      ['dark', 'rgb(13, 13, 13)'],
    ] as Array<[Mode, string]>) {
      const control = await settingsSwitch(page, 'default', mode);

      expect(await measure(control)).toEqual({ track: [44, 24], thumb: 20, thumbColor: surface });
    }
  });
});
