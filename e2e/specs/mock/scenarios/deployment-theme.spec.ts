import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { defaultTheme } from '../../../../packages/client/src/theme/themes/default';
import { darkTheme } from '../../../../packages/client/src/theme/themes/dark';
import { getE2EUser } from '../../../setup/user';
import { themeValue } from './style.helpers';

/**
 * `interface.theme` in librechat.yaml reaches the client through `/api/config`,
 * both before sign-in and after it. Each scenario serves the value there and
 * nothing through storage, so the theme can only come from the config. The mode
 * comes from the project (light, dark, mobile), and every expectation is read
 * for the mode the page actually resolved.
 */

type Mode = 'light' | 'dark';
/** `null` serves a payload with no `interface.theme`. */
type ConfigTheme = string | Record<string, unknown> | null;

const STORED_DEFINITION = {
  version: 1,
  name: 'stored',
  modes: {
    light: { colors: { 'rgb-surface-primary': '250 240 230' } },
    dark: { colors: { 'rgb-surface-primary': '30 20 10' } },
  },
};

const INLINE_THEME = {
  version: 1,
  name: 'acme',
  modes: {
    light: {
      colors: { 'rgb-surface-primary': '240 244 255' },
      appearance: { controlRadius: '2px' },
    },
    dark: {
      colors: { 'rgb-surface-primary': '12 16 32' },
      appearance: { controlRadius: '2px' },
    },
  },
};

test.use({ storageState: { cookies: [], origins: [] } });

/** Serves `signedOut` on the pre-login payload and `signedIn` once a token is sent. */
async function serveTheme(page: Page, signedOut: ConfigTheme, signedIn: ConfigTheme = signedOut) {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const authenticated = Boolean(route.request().headers()['authorization']);
      const theme = authenticated ? signedIn : signedOut;
      const response = await route.fetch();
      const body = await response.json();
      const served = { ...body.interface };
      delete served.theme;
      if (theme !== null) {
        served.theme = theme;
      }
      await route.fulfill({ response, json: { ...body, interface: served } });
    },
  );
}

async function seedStorage(page: Page, entries: Record<string, string>) {
  await page.addInitScript((values) => {
    if (sessionStorage.getItem('e2e-seeded')) {
      return;
    }
    sessionStorage.setItem('e2e-seeded', '1');
    for (const [key, value] of Object.entries(values)) {
      localStorage.setItem(key, value);
    }
  }, entries);
}

async function resolvedMode(page: Page): Promise<Mode> {
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  return dark ? 'dark' : 'light';
}

async function openLogin(page: Page) {
  await page.goto('/login');
  await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 20000 });
}

async function signIn(page: Page) {
  const user = getE2EUser();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
  await page.waitForURL(/\/c\/new/, { timeout: 20000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 20000,
  });
}

async function expectClickHouse(page: Page) {
  const colors = clickHouseTheme.modes[await resolvedMode(page)]?.colors ?? {};
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
  expect(await themeValue(page, '--surface-primary')).toBe(colors['rgb-surface-primary']);
  expect(await themeValue(page, '--theme-control-radius')).toBe('0.25rem');
}

const storedDefinition = (page: Page) =>
  page.evaluate(() => localStorage.getItem('theme-definition'));

test.describe('deployment theme from librechat.yaml', () => {
  test('a bundled deployment theme paints the login page and the chat without being saved @scenario:deployment-theme-paints-login-and-chat', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await serveTheme(page, 'clickhouse');

    await openLogin(page);
    await expectClickHouse(page);
    expect(await storedDefinition(page)).toBeNull();

    await signIn(page);
    await expectClickHouse(page);
    expect(await storedDefinition(page)).toBeNull();
  });

  test('an inline deployment theme applies its own colors and appearance @scenario:inline-deployment-theme-applies-its-colors', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await serveTheme(page, INLINE_THEME);

    await openLogin(page);
    const mode = await resolvedMode(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'acme');
    expect(await themeValue(page, '--surface-primary')).toBe(
      INLINE_THEME.modes[mode].colors['rgb-surface-primary'],
    );
    expect(await themeValue(page, '--theme-control-radius')).toBe('2px');
    expect(await storedDefinition(page)).toBeNull();
  });

  test('an invalid deployment theme is ignored and the default look stays @scenario:invalid-deployment-theme-keeps-default-look', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('[DeploymentTheme]')) {
        warnings.push(message.text());
      }
    });
    await serveTheme(page, {
      ...INLINE_THEME,
      modes: { light: { colors: { 'rgb-not-a-token': 'red' } } },
    });

    await openLogin(page);
    const palette = (await resolvedMode(page)) === 'dark' ? darkTheme : defaultTheme;
    await expect.poll(() => warnings.length).toBeGreaterThan(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'acme');
    expect(await themeValue(page, '--surface-primary')).toBe(palette['rgb-surface-primary']);
  });

  test('withdrawing the deployment theme after sign-in brings back the user theme @scenario:withdrawn-deployment-theme-restores-user-theme', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const stored = JSON.stringify(STORED_DEFINITION);
    await seedStorage(page, { 'theme-definition': stored, 'theme-source': 'definition' });
    await serveTheme(page, 'clickhouse', null);

    await openLogin(page);
    await expectClickHouse(page);

    await signIn(page);
    const mode = await resolvedMode(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'stored');
    expect(await themeValue(page, '--surface-primary')).toBe(
      STORED_DEFINITION.modes[mode].colors['rgb-surface-primary'],
    );
    expect(await storedDefinition(page)).toBe(stored);
  });

  test('a high-contrast mode outranks the deployment theme @scenario:high-contrast-outranks-deployment-theme', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await seedStorage(page, { 'color-theme': 'high-contrast-dark' });
    await serveTheme(page, 'clickhouse');

    await openLogin(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
    expect(await themeValue(page, '--surface-primary')).not.toBe(
      clickHouseTheme.modes.dark?.colors?.['rgb-surface-primary'],
    );
  });
});
