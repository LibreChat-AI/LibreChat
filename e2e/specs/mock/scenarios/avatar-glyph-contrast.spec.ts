import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The default user avatar's glyph is a graphical object under WCAG 1.4.11 (Non-text Contrast), so
 * it owes 3:1 against the `avatar-fill` behind it. Light mode keeps its #212121 ink; dark mode
 * inks it white, since the #ececec primary text held only 2.6:1 on the #7989ff fill.
 */

type Mode = 'light' | 'dark';

const THEME_PARAM = 'e2eThemeMode';
const MISSING_AVATAR = 'https://avatar.e2e.invalid/missing.png';
const WCAG_NON_TEXT_MIN = 3;
const EXPECTED: Record<Mode, { fill: string; glyph: string }> = {
  light: { fill: 'rgb(121, 137, 255)', glyph: 'rgb(33, 33, 33)' },
  dark: { fill: 'rgb(121, 137, 255)', glyph: 'rgb(255, 255, 255)' },
};

test.use({ viewport: { width: 1280, height: 800 } });

async function installThemeBridge(page: Page) {
  await page.addInitScript(() => {
    const mode = new URL(location.href).searchParams.get('e2eThemeMode');
    if (mode) {
      localStorage.setItem('color-theme', mode);
    }
    localStorage.setItem('navVisible', 'true');
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    localStorage.removeItem('theme-definition');
    localStorage.removeItem('theme-source');
  });
}

/** The default avatar only draws once the user's image fails to load. */
async function failUserAvatar(page: Page) {
  await page.route(`${MISSING_AVATAR}*`, (route) => route.abort());
  await page.route('**/api/user', async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({ response, json: { ...user, avatar: MISSING_AVATAR } });
  });
}

const channels = (color: string): number[] =>
  (color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

/** WCAG 2 relative luminance of an sRGB colour. */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Renders the default avatar in `mode` and reads the glyph's stroke and the fill behind it. */
async function defaultAvatarPaint(page: Page, mode: Mode) {
  await installThemeBridge(page);
  await failUserAvatar(page);
  await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${mode}`);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(mode === 'dark');

  const avatar = page.getByTestId('nav-user').locator('div[aria-hidden="true"]').first();
  await expect(avatar).toBeVisible({ timeout: 20000 });
  const paint = await avatar.evaluate((node) => {
    const mark = node.querySelector('svg');
    return {
      fill: getComputedStyle(node).backgroundColor,
      glyph: mark ? getComputedStyle(mark).stroke : '',
    };
  });
  await test.info().attach(`default-avatar-${mode}`, {
    body: await avatar.screenshot(),
    contentType: 'image/png',
  });
  return paint;
}

test.describe('default avatar glyph contrast', () => {
  test.describe.configure({ timeout: 60000 });

  test('the default avatar glyph keeps its light ink at 3:1 or more @scenario:default-avatar-glyph-contrast-light', async ({
    page,
  }) => {
    const { fill, glyph } = await defaultAvatarPaint(page, 'light');

    expect({ fill, glyph }).toEqual(EXPECTED.light);
    expect(contrast(glyph, fill)).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MIN);
  });

  test('the default avatar glyph clears 3:1 on its fill in dark mode @scenario:default-avatar-glyph-contrast-dark', async ({
    page,
  }) => {
    const { fill, glyph } = await defaultAvatarPaint(page, 'dark');

    expect({ fill, glyph }).toEqual(EXPECTED.dark);
    expect(contrast(glyph, fill)).toBeGreaterThanOrEqual(WCAG_NON_TEXT_MIN);
  });
});
