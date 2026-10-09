import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The `option` InputNumber is a borderless value beside a setting's label. rc-input-number puts
 * the focus on an input nested inside the wrapper the variant styles, so the focused fill has to
 * follow that input: a keyboard user tabbing to the value sees the field fill in
 * `surface-secondary` and the input's own outline, and both leave with the focus. The probe is
 * the playback rate value on the Speech tab of the settings dialog.
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
    localStorage.setItem('textToSpeech', 'true');
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

async function playbackRate(page: Page, theme: ThemeChoice, mode: Mode): Promise<Locator> {
  await page.goto(`${NEW_CHAT_PATH}?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: 'Speech' }).click();
  const input = dialog.getByRole('spinbutton', { name: 'Audio Playback Rate' });
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  return input;
}

/** The variant's root: the nearest ancestor carrying the `rc-input-number` class token itself. */
const wrapperOf = (input: Locator) =>
  input.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rc-input-number ")][1]',
  );

const backgroundOf = (target: Locator) =>
  target.evaluate((node) => getComputedStyle(node).backgroundColor);

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
const CASES: Array<{ name: string; tag: string; theme: ThemeChoice; mode: Mode }> = [
  {
    name: 'light mode',
    tag: '@scenario:input-number-option-focus-light',
    theme: 'default',
    mode: 'light',
  },
  {
    name: 'dark mode',
    tag: '@scenario:input-number-option-focus-dark',
    theme: 'default',
    mode: 'dark',
  },
  {
    name: 'the ClickHouse theme in light mode',
    tag: '@scenario:input-number-option-focus-clickhouse-light',
    theme: 'clickhouse',
    mode: 'light',
  },
  {
    name: 'the ClickHouse theme in dark mode',
    tag: '@scenario:input-number-option-focus-clickhouse-dark',
    theme: 'clickhouse',
    mode: 'dark',
  },
];

test.describe('InputNumber option variant focus', () => {
  for (const { name, tag, theme, mode } of CASES) {
    test(`a keyboard-focused option value shows its focused fill and outline in ${name} ${tag}`, async ({
      page,
    }) => {
      await installThemeBridge(page);
      const input = await playbackRate(page, theme, mode);
      const wrapper = wrapperOf(input);
      const focusedFill = await probeStyle(page, 'bg-surface-secondary', 'background-color');

      await page.mouse.move(0, 0);
      const resting = await backgroundOf(wrapper);
      expect(resting).not.toBe(focusedFill);

      await page.getByRole('slider', { name: 'Audio Playback Rate' }).focus();
      await page.keyboard.press('Tab');
      await expect(input).toBeFocused();
      await expect.poll(() => backgroundOf(wrapper)).toBe(focusedFill);
      const outline = await input.evaluate((node) => {
        const style = getComputedStyle(node);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
      });
      expect(outline.style).not.toBe('none');
      expect(outline.width).toBeGreaterThanOrEqual(2);

      await page.keyboard.press('Shift+Tab');
      await expect(input).not.toBeFocused();
      await expect.poll(() => backgroundOf(wrapper)).toBe(resting);
    });
  }
});
