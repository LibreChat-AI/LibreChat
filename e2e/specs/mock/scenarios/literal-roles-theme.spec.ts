import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { themeValue } from './style.helpers';

/**
 * Colours that used to be literals in components now read roles: the default avatar's hairline
 * (`avatar-edge`), the file drop zone's artwork (`illustration-*`) and a dragged badge's lift
 * (`elevationDrag`). Without a theme each paints exactly what the literal did; the ClickHouse
 * definition repaints the artwork from Click UI's info ramp.
 */

type Mode = 'light' | 'dark';

const MODES: Mode[] = ['light', 'dark'];
const THEME_PARAM = 'e2eThemeMode';
const MISSING_AVATAR = 'https://avatar.e2e.invalid/missing.png';
const DROP_PROMPT = 'Drop any file here to add it to the conversation';
const STOCK_ARTWORK = ['rgb(175, 193, 255)', 'rgb(121, 137, 255)', 'rgb(60, 70, 255)'];

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

const rgbCss = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

/** The default avatar only draws once the user's image fails to load. */
async function failUserAvatar(page: Page) {
  await page.route(`${MISSING_AVATAR}*`, (route) => route.abort());
  await page.route('**/api/user', async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({ response, json: { ...user, avatar: MISSING_AVATAR } });
  });
}

/** Drags a file over the composer and reads the three fills of the drop zone's artwork. */
async function dropZoneArtwork(page: Page): Promise<string[]> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: 20000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    return transfer;
  });
  await input.dispatchEvent('dragenter', { dataTransfer });
  await input.dispatchEvent('dragover', { dataTransfer });
  const prompt = page.getByText(DROP_PROMPT, { exact: true });
  await expect(prompt).toBeVisible();
  const fills = await prompt.evaluate((node) =>
    Array.from(node.parentElement?.querySelectorAll('svg > g > path, svg > path') ?? []).map(
      (path) => getComputedStyle(path).fill,
    ),
  );
  await input.dispatchEvent('dragleave', { dataTransfer });
  return fills;
}

test.describe('roles for former colour literals', () => {
  test('the default avatar keeps its hairline in both modes @scenario:default-avatar-keeps-its-hairline', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, null);
    await failUserAvatar(page);

    for (const mode of MODES) {
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      const avatar = page.getByTestId('nav-user').locator('div[aria-hidden="true"]').first();
      await expect(avatar).toBeVisible({ timeout: 20000 });
      const shadow = await avatar.evaluate((node) => getComputedStyle(node).boxShadow);
      expect(shadow).toContain('rgba(240, 246, 252, 0.1) 0px 0px 0px 1px');
    }
  });

  test('the drop zone artwork keeps its blues without a theme @scenario:drop-zone-artwork-keeps-its-blues', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, null);

    for (const mode of MODES) {
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      expect(await dropZoneArtwork(page)).toEqual(STOCK_ARTWORK);
    }
  });

  test('the ClickHouse definition paints the drop zone artwork from Click UI @scenario:clickhouse-drop-zone-artwork-follows-click-ui', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, clickHouseTheme);

    for (const mode of MODES) {
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};
      await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      expect(await dropZoneArtwork(page)).toEqual([
        rgbCss(colors['rgb-illustration-subtle']),
        rgbCss(colors['rgb-illustration']),
        rgbCss(colors['rgb-illustration-strong']),
      ]);
    }
  });

  test('a dragged badge lifts with the theme elevation @scenario:dragged-badge-lift-follows-the-theme', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await installThemeBridge(page, null);
    await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=light`);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 20000,
    });
    expect(await themeValue(page, '--theme-elevation-drag')).toBe('0 10px 25px rgb(0 0 0 / 0.1)');

    await installThemeBridge(page, clickHouseTheme);
    await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=light`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    expect(await themeValue(page, '--theme-elevation-drag')).toBe(
      clickHouseTheme.modes.light?.appearance?.elevationDrag,
    );
  });
});
