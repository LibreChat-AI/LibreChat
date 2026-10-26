import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The stylesheet-level roles (`select-fill`, `select-edge`, `button-neutral-*`, `link-inline`,
 * `page-canvas`) are registry colours. Without a theme they paint exactly the values the
 * stylesheet held; the ClickHouse definition repaints them from Click UI.
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
  }, definition ?? null);
}

interface Painted {
  selectFill: string;
  selectEdge: string;
  neutralBorder: string;
  neutralText: string;
  canvas: string;
}

/** Mounts a native select and a `.btn-neutral` probe and reads what each paints. */
async function paintedRoles(page: Page): Promise<Painted> {
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 20000,
  });
  return page.evaluate(() => {
    const select = document.createElement('select');
    const button = document.createElement('button');
    button.className = 'btn-neutral';
    document.body.append(select, button);
    const selectStyle = getComputedStyle(select);
    const buttonStyle = getComputedStyle(button);
    const result = {
      selectFill: selectStyle.backgroundColor,
      selectEdge: selectStyle.borderTopColor,
      neutralBorder: buttonStyle.borderTopColor,
      neutralText: buttonStyle.color,
      canvas: getComputedStyle(document.body).backgroundColor,
    };
    select.remove();
    button.remove();
    return result;
  });
}

/** The RGBA a colour paints, whatever syntax the browser serialises it in. */
const rgba = (page: Page, color: string): Promise<number[]> =>
  page.evaluate((value) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) {
      return [];
    }
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }, color);

const STOCK: Record<Mode, Record<keyof Painted, string>> = {
  light: {
    selectFill: 'rgb(255 255 255)',
    selectEdge: 'rgb(142 142 160)',
    neutralBorder: 'rgb(0 0 0 / 0.1)',
    neutralText: 'rgb(64 65 79)',
    canvas: '',
  },
  dark: {
    selectFill: 'rgb(255 255 255)',
    selectEdge: 'rgb(142 142 160)',
    neutralBorder: 'rgb(66 66 66)',
    neutralText: 'rgb(255 255 240)',
    canvas: 'rgb(23 23 23)',
  },
};

const triplet = (value: string | undefined) => `rgb(${value ?? ''})`;

test.describe('stylesheet roles', () => {
  test('stock stylesheet roles keep their values in both modes @scenario:stylesheet-roles-keep-stock-values', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, null);
    for (const mode of MODES) {
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      const got = await paintedRoles(page);
      for (const key of Object.keys(STOCK[mode]) as Array<keyof Painted>) {
        if (STOCK[mode][key] === '') {
          continue;
        }
        expect([mode, key, await rgba(page, got[key])]).toEqual([
          mode,
          key,
          await rgba(page, STOCK[mode][key]),
        ]);
      }
    }
  });

  test('the ClickHouse theme repaints the stylesheet roles from Click UI @scenario:stylesheet-roles-follow-clickhouse', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, clickHouseTheme);
    for (const mode of MODES) {
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};
      const got = await paintedRoles(page);
      const want: Painted = {
        selectFill: triplet(colors['rgb-select-fill']),
        selectEdge: triplet(colors['rgb-select-edge']),
        neutralBorder: triplet(colors['rgb-button-neutral-border']),
        neutralText: triplet(colors['rgb-button-neutral-text']),
        canvas: mode === 'dark' ? triplet(colors['rgb-page-canvas']) : '',
      };
      for (const key of Object.keys(want) as Array<keyof Painted>) {
        if (want[key] === '') {
          continue;
        }
        expect([mode, key, await rgba(page, got[key])]).toEqual([
          mode,
          key,
          await rgba(page, want[key]),
        ]);
      }
    }
  });
});
