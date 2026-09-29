import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { themeValue } from './style.helpers';

/**
 * A definition written for a newer frontend can name an appearance token this build does not
 * know. The stored and deployment paths both keep the rest of such a definition and drop only
 * that token, while a bad value for a known token or an injection attempt still rejects it.
 */
test.describe.configure({ timeout: 120_000 });

const withAppearance = (name: string, appearance: Record<string, unknown>) => ({
  version: 1,
  name,
  modes: {
    light: { colors: { 'rgb-surface-primary': '240 244 255' }, appearance },
    dark: { colors: { 'rgb-surface-primary': '12 16 32' }, appearance },
  },
});

const NEWER_THEME = withAppearance('e2e-newer', { controlRadius: '2px', futureSpacing: '3rem' });

async function storeTheme(page: Page, definition: Record<string, unknown>) {
  await page.addInitScript((theme) => {
    localStorage.setItem('color-theme', 'light');
    localStorage.setItem('theme-definition', JSON.stringify(theme));
    localStorage.setItem('theme-source', 'definition');
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
  }, definition);
}

async function serveTheme(page: Page, theme: Record<string, unknown>) {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, interface: { ...body.interface, theme } } });
    },
  );
}

async function openChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
}

async function expectNewerThemeApplied(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', NEWER_THEME.name);
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  expect(await themeValue(page, '--surface-primary')).toBe(dark ? '12 16 32' : '240 244 255');
  expect(await themeValue(page, '--theme-control-radius')).toBe('2px');
  expect(await page.locator('html').getAttribute('style')).not.toContain('3rem');
}

test.describe('appearance tokens this build does not know', () => {
  test('a stored theme with an unknown appearance token keeps its colors and known tokens @scenario:stored-theme-unknown-appearance-token-applies-rest', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });
    await storeTheme(page, NEWER_THEME);

    await openChat(page);

    await expectNewerThemeApplied(page);
    expect(warnings.join('\n')).toContain('Unknown light appearance token ignored: futureSpacing');
    const stored = await page.evaluate(() => localStorage.getItem('theme-definition'));
    expect(JSON.parse(stored ?? '{}')).toEqual(NEWER_THEME);
  });

  test('a deployment theme with an unknown appearance token keeps its colors and known tokens @scenario:deployment-theme-unknown-appearance-token-applies-rest', async ({
    page,
  }) => {
    await serveTheme(page, NEWER_THEME);

    await openChat(page);

    await expectNewerThemeApplied(page);
  });

  test('a stored theme with an invalid value for a known appearance token is still rejected @scenario:stored-theme-invalid-known-appearance-rejected', async ({
    page,
  }) => {
    const theme = withAppearance('e2e-invalid-known', {
      controlRadius: 'huge',
      futureSpacing: '3rem',
    });
    await storeTheme(page, theme);

    await openChat(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme.name);
    expect(await themeValue(page, '--theme-control-radius')).not.toBe('huge');
  });

  test('a deployment theme carrying CSS in an unknown appearance token is still rejected @scenario:deployment-theme-appearance-injection-rejected', async ({
    page,
  }) => {
    const theme = withAppearance('e2e-injection', {
      futureSpacing: '1rem; } body { display: none',
    });
    await serveTheme(page, theme);

    await openChat(page);

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', theme.name);
    await expect(page.locator('body')).toBeVisible();
  });
});

/**
 * The same holds for a color role added after this build: a well-formed `rgb-` name with a valid
 * triplet is dropped with a warning, so a newer definition keeps every color this build paints.
 */
test.describe('color tokens this build does not know', () => {
  const NEWER_COLORS = {
    version: 1,
    name: 'e2e-newer-colors',
    modes: {
      light: { colors: { 'rgb-surface-primary': '240 244 255', 'rgb-future-role': '1 2 3' } },
      dark: { colors: { 'rgb-surface-primary': '12 16 32', 'rgb-future-role': '1 2 3' } },
    },
  };

  test('a stored theme with an unknown color role keeps the colors this build paints @scenario:stored-theme-unknown-color-token-applies-rest', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') {
        warnings.push(message.text());
      }
    });
    await storeTheme(page, NEWER_COLORS);

    await openChat(page);

    await expect(page.locator('html')).toHaveAttribute('data-theme', NEWER_COLORS.name);
    const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    expect(await themeValue(page, '--surface-primary')).toBe(dark ? '12 16 32' : '240 244 255');
    expect(await themeValue(page, '--future-role')).toBe('');
    expect(warnings.join('\n')).toContain('color token ignored: rgb-future-role');
  });
});
