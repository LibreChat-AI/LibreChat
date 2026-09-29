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

async function storeTheme(page: Page, definition: unknown, mode: Mode) {
  await page.addInitScript(
    ([stored, colorMode]) => {
      localStorage.setItem('color-theme', colorMode as string);
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
    [definition ?? null, mode] as const,
  );
}

async function settingsSwitch(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
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

async function measure(control: Locator) {
  return control.evaluate((node) => {
    const track = node.getBoundingClientRect();
    const thumb = node.firstElementChild as HTMLElement;
    const knob = thumb.getBoundingClientRect();
    return {
      track: [Math.round(track.width), Math.round(track.height)],
      thumb: Math.round(knob.width),
      thumbColor: getComputedStyle(thumb).backgroundColor,
    };
  });
}

const rgb = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

test.describe('theme switch', () => {
  test('the switch takes Click UI geometry and knob color under the ClickHouse theme @scenario:clickhouse-switch-follows-click-ui', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as Mode[]) {
      await storeTheme(page, clickHouseTheme, mode);
      const control = await settingsSwitch(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode}\\b`));

      const knob = clickHouseTheme.modes[mode]?.colors?.['rgb-switch-thumb'];
      expect(await measure(control)).toEqual({
        track: [32, 16],
        thumb: 12,
        thumbColor: rgb(knob),
      });
    }
  });

  test('the default theme keeps its switch @scenario:default-theme-switch-unchanged', async ({
    page,
  }) => {
    for (const [mode, surface] of [
      ['light', 'rgb(255, 255, 255)'],
      ['dark', 'rgb(13, 13, 13)'],
    ] as Array<[Mode, string]>) {
      await storeTheme(page, null, mode);
      const control = await settingsSwitch(page);

      expect(await measure(control)).toEqual({ track: [44, 24], thumb: 20, thumbColor: surface });
    }
  });
});
