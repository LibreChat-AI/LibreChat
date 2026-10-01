import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH, uniqueName, uploadViaUnifiedButton } from '../helpers';

/**
 * A file chip's tile reads its kind's `file-*` role and its glyph `file-ink`. Without a theme a
 * text document keeps the pink tile and white glyph it always had; the ClickHouse definition
 * draws the tile from Click UI's palette.
 */

type Mode = 'light' | 'dark';

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';

test.use({ viewport: { width: 1280, height: 800 } });

async function installThemeBridge(page: Page, definition: unknown) {
  await page.addInitScript((stored) => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored) {
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, definition ?? null);
}

const rgbCss = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

/** Attaches a text file and reads its chip's tile fill and glyph stroke. */
async function tilePaint(page: Page, mode: Mode) {
  await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 20000,
  });
  const name = `${uniqueName('tile')}.txt`;
  const upload = await uploadViaUnifiedButton(page, {
    name,
    mimeType: 'text/plain',
    content: 'A short note.',
  });
  expect(upload.ok()).toBeTruthy();

  const tray = page.getByTestId('composer-tray');
  const tile = tray.locator('svg rect[width="36"][height="36"]').first();
  await expect(tile).toBeVisible({ timeout: 20000 });
  const glyph = tray.locator('svg path[stroke-width], svg path.stroke-file-ink').first();
  await expect(glyph).toBeVisible();
  return {
    fill: await tile.evaluate((node) => getComputedStyle(node).fill),
    ink: await glyph.evaluate((node) => getComputedStyle(node).stroke),
  };
}

test.describe('file-type tile roles', () => {
  test('a text file keeps its pink tile and white glyph without a theme @scenario:file-tile-keeps-its-colours', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await installThemeBridge(page, null);

    for (const mode of MODES) {
      expect(await tilePaint(page, mode)).toEqual({
        fill: 'rgb(255, 85, 136)',
        ink: 'rgb(255, 255, 255)',
      });
    }
  });

  test('the ClickHouse definition draws the tile from Click UI @scenario:clickhouse-file-tile-follows-click-ui', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await installThemeBridge(page, clickHouseTheme);

    for (const mode of MODES) {
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};
      const paint = await tilePaint(page, mode);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      expect(paint).toEqual({
        fill: rgbCss(colors['rgb-file-document']),
        ink: rgbCss(colors['rgb-file-ink']),
      });
    }
  });
});
