import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The plain `rounded-*`, `font-sans` and `font-mono` utilities read `--theme-radius-*` and the
 * theme font families, so a theme's appearance reshapes existing call sites. The mention menu
 * carries `rounded-2xl` and opens from the composer, which makes it the shortest path to a real
 * element on the radius scale. Every theme here pins light mode so the desktop-dark project
 * cannot pick a mode the definition does not carry.
 */
test.describe.configure({ timeout: 120_000 });

async function storeTheme(page: Page, definition: Record<string, unknown>) {
  await page.addInitScript((theme) => {
    localStorage.setItem('color-theme', 'light');
    localStorage.setItem('theme-definition', JSON.stringify(theme));
    localStorage.setItem('theme-source', 'definition');
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
  }, definition);
}

async function openComposer(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await expect(composer).toBeVisible({ timeout: 30000 });
  return composer;
}

async function openMentionMenu(page: Page): Promise<Locator> {
  const composer = await openComposer(page);
  await composer.click();
  await composer.pressSequentially('@');
  const search = page.getByPlaceholder('Mention an endpoint');
  await expect(search).toBeVisible({ timeout: 15000 });
  const menu = page.locator('div.popover').filter({ has: search });
  await expect(menu).toBeVisible();
  return menu;
}

const radius = (element: Locator) =>
  element.evaluate((node) => getComputedStyle(node).borderTopLeftRadius);

test.describe('theme radius and font scales', () => {
  test('without a theme the radius scale keeps its previous values @scenario:default-radius-scale-unchanged', async ({
    page,
  }) => {
    const menu = await openMentionMenu(page);

    expect(await radius(menu)).toBe('16px');
    expect(await probeStyle(page, 'rounded-sm', 'border-top-left-radius')).toBe('4px');
    expect(await probeStyle(page, 'rounded-md', 'border-top-left-radius')).toBe('6px');
    expect(await probeStyle(page, 'rounded', 'border-top-left-radius')).toBe('4px');
  });

  test('a theme radius step reshapes the mention menu @scenario:theme-radius-step-reshapes-mention-menu', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-square',
      modes: { light: { appearance: { radius2xl: '3px' } } },
    };
    await storeTheme(page, theme);

    const menu = await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);

    await expect.poll(() => radius(menu)).toBe('3px');
  });

  test('theme font families reach the interface and code text @scenario:theme-font-families-reach-ui-and-code', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-typefaces',
      modes: {
        light: {
          appearance: { fontFamily: 'Georgia, serif', monoFontFamily: "'Courier New', monospace" },
        },
      },
    };
    await storeTheme(page, theme);

    const composer = await openComposer(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);

    await expect
      .poll(() => composer.evaluate((node) => getComputedStyle(node).fontFamily))
      .toContain('Georgia');
    expect(await probeStyle(page, 'font-mono', 'font-family')).toContain('Courier New');
    expect(await probeStyle(page, '', 'font-family', 'code')).toContain('Courier New');
  });

  test('the small radii keep their pixel offset at a larger root font size @scenario:small-radii-keep-px-offset-at-larger-root-font', async ({
    page,
  }) => {
    await openComposer(page);
    /** Stands in for a browser whose default font size is 20px. */
    await page.addStyleTag({ content: 'html { font-size: 20px !important; }' });

    expect(await probeStyle(page, 'rounded-sm', 'border-top-left-radius')).toBe('6px');
    expect(await probeStyle(page, 'rounded-md', 'border-top-left-radius')).toBe('8px');
    expect(await probeStyle(page, 'rounded', 'border-top-left-radius')).toBe('5px');
  });

  test('a theme with calc() radii like the shipped defaults applies @scenario:calc-radius-theme-applies', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-offset-radii',
      modes: { light: { appearance: { radiusSm: 'calc(1rem - 4px)' } } },
    };
    await storeTheme(page, theme);

    await openComposer(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);

    expect(await probeStyle(page, 'rounded-sm', 'border-top-left-radius')).toBe('12px');
  });

  test('a theme with a malformed radius is rejected and the default radius stays @scenario:malformed-radius-theme-keeps-default', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-malformed-radius',
      modes: { light: { appearance: { radius2xl: 'calc(1rem - var(--x))' } } },
    };
    await storeTheme(page, theme);

    const menu = await openMentionMenu(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme.name);
    expect(await radius(menu)).toBe('16px');
  });
});
