import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The plain `shadow-*` utilities read `--theme-shadow-*`, so a theme's appearance reshapes the
 * existing call sites. The mention menu carries `shadow-lg` and opens from the composer, which
 * makes it the shortest path to a real element on that scale. Every theme here pins light mode
 * so the desktop-dark project cannot pick a mode the definition does not carry.
 */
test.describe.configure({ timeout: 120_000 });

const DEFAULT_LG = 'rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.1) 0px 4px 6px -4px';

async function storeTheme(page: Page, definition: Record<string, unknown>) {
  await page.addInitScript((theme) => {
    localStorage.setItem('color-theme', 'light');
    localStorage.setItem('theme-definition', JSON.stringify(theme));
    localStorage.setItem('theme-source', 'definition');
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
  }, definition);
}

async function openMentionMenu(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await expect(composer).toBeVisible({ timeout: 30000 });
  await composer.click();
  await composer.pressSequentially('@');
  const search = page.getByPlaceholder('Mention an endpoint');
  await expect(search).toBeVisible({ timeout: 15000 });
  const menu = page.locator('div.popover').filter({ has: search });
  await expect(menu).toBeVisible();
  return menu;
}

const boxShadow = (element: Locator) =>
  element.evaluate((node) => getComputedStyle(node).boxShadow);

test.describe('theme shadow scale', () => {
  test('the mention menu keeps its default large shadow without a theme @scenario:mention-menu-keeps-default-large-shadow', async ({
    page,
  }) => {
    const menu = await openMentionMenu(page);

    expect(await boxShadow(menu)).toContain(DEFAULT_LG);
  });

  test('a theme shadow step reshapes the mention menu @scenario:theme-shadow-step-reshapes-mention-menu', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-shadow-scale',
      modes: { light: { appearance: { shadowLg: '0 8px 16px rgb(9 240 120)' } } },
    };
    await storeTheme(page, theme);

    const menu = await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);

    await expect.poll(() => boxShadow(menu)).toContain('rgb(9, 240, 120) 0px 8px 16px 0px');
    expect(await boxShadow(menu)).not.toContain(DEFAULT_LG);
  });

  test('a disabled shadow step keeps a ring on the same element @scenario:disabled-shadow-step-keeps-ring', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-flat-shadows',
      modes: { light: { appearance: { shadow2xl: 'none' } } },
    };
    await storeTheme(page, theme);

    await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);

    /** Tailwind lists the shadow after the ring layers; a bare `none` there would void both. */
    const composed = await probeStyle(page, 'shadow-2xl ring-2', 'box-shadow');
    expect(composed).not.toBe('none');
    expect(composed).toContain('0px 0px 0px 2px');
    expect(composed).not.toContain('25px 50px');
  });

  test('a theme with a malformed shadow is rejected and the default shadow stays @scenario:malformed-shadow-theme-keeps-default-shadow', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-malformed-shadow',
      /** Well formed but for the color, which only the browser's own parser can reject. */
      modes: { light: { appearance: { shadowLg: '0 8px 16px not-a-color' } } },
    };
    await storeTheme(page, theme);

    const menu = await openMentionMenu(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme.name);
    expect(await boxShadow(menu)).toContain(DEFAULT_LG);
  });

  test('a shadow step naming an unknown environment variable is rejected and the default stays @scenario:env-shadow-step-keeps-default-shadow', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-env-shadow',
      /** The browser cannot check `env()` before substitution, and this name does not exist. */
      modes: { light: { appearance: { shadowLg: '0 env(safe-area-inset-tpo) 1px black' } } },
    };
    await storeTheme(page, theme);

    const menu = await openMentionMenu(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme.name);
    expect(await boxShadow(menu)).toContain(DEFAULT_LG);
  });

  test('a released theme with a variable-backed surface elevation still loads @scenario:variable-surface-elevation-theme-still-loads', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-variable-elevation',
      modes: {
        light: { appearance: { elevationSurface: '0 8px 16px rgb(var(--e2e-shadow, 9 240 120))' } },
      },
    };
    await storeTheme(page, theme);

    await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);

    /** No app call site uses `shadow-theme-surface`, so the probe reads the role's property. */
    const surface = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.boxShadow = 'var(--theme-elevation-surface)';
      document.body.append(probe);
      const value = getComputedStyle(probe).boxShadow;
      probe.remove();
      return value;
    });
    expect(surface).toContain('rgb(9, 240, 120) 0px 8px 16px 0px');
  });
});
