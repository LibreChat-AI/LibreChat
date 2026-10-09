import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * The sign-in form's floating-label field and submit button take their height and corner from
 * the `authFieldHeight`, `authButtonHeight` and `authControlRadius` appearance roles. The stock
 * theme keeps the 44px field, the 48px button and the 16px corner they always drew; a theme
 * served through `interface.theme` reshapes all three without touching the form.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const REFERENCE_THEME = {
  version: 1,
  name: 'auth-shape-reference',
  modes: {
    light: {
      appearance: { authFieldHeight: '3.5rem', authButtonHeight: '2.5rem', authControlRadius: '0' },
    },
    dark: {
      appearance: { authFieldHeight: '3.5rem', authButtonHeight: '2.5rem', authControlRadius: '0' },
    },
  },
};

async function serveTheme(page: Page, theme: string | Record<string, unknown>) {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, interface: { ...body.interface, theme } } });
    },
  );
}

async function openLogin(page: Page) {
  await page.goto('/login');
  await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 20000 });
}

async function shapeOf(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      radius: style.borderTopLeftRadius,
    };
  });
}

/** The typed value has to fit inside the field at any height, so nothing clips it. */
async function expectValueFits(field: Locator) {
  await field.fill('someone@example.com');
  const fits = await field.evaluate((element) => {
    const input = element as HTMLInputElement;
    return input.scrollHeight <= input.clientHeight;
  });
  expect(fits).toBe(true);
}

async function expectShape(
  page: Page,
  expected: { field: number; button: number; radius: string },
) {
  const field = page.getByLabel('Email');
  const password = page.getByLabel('Password');
  const button = page.getByTestId('login-button');
  expect(await shapeOf(field)).toEqual({ height: expected.field, radius: expected.radius });
  expect(await shapeOf(password)).toEqual({ height: expected.field, radius: expected.radius });
  expect(await shapeOf(button)).toEqual({ height: expected.button, radius: expected.radius });
  await expectValueFits(field);
}

test.describe('sign-in control shape roles', () => {
  test('the stock theme keeps the sign-in field, button and corner it always drew @scenario:sign-in-controls-keep-default-shape', async ({
    page,
  }) => {
    await openLogin(page);
    await expectShape(page, { field: 44, button: 48, radius: '16px' });
  });

  test('the ClickHouse theme draws the sign-in controls at its own height and corner @scenario:clickhouse-reshapes-sign-in-controls', async ({
    page,
  }) => {
    await serveTheme(page, 'clickhouse');
    await openLogin(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    await expectShape(page, { field: 32, button: 32, radius: '4px' });
  });

  test('a theme that names the sign-in roles reshapes the controls without touching the form @scenario:theme-reshapes-sign-in-controls', async ({
    page,
  }) => {
    await serveTheme(page, REFERENCE_THEME);
    await openLogin(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', REFERENCE_THEME.name);
    await expectShape(page, { field: 56, button: 40, radius: '0px' });
  });
});
