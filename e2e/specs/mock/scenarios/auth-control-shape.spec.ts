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
  const reveal = page.getByRole('button', { name: /show/i });
  await expectWithin(reveal, password);
  await expectClearOfValue(reveal, password);
  await expectValueFits(field);
}

/** A control drawn inside a field, or a label resting in it, stays inside the field's box. */
async function expectWithin(inner: Locator, outer: Locator) {
  const [box, frame] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(box).not.toBeNull();
  expect(frame).not.toBeNull();
  if (!box || !frame) {
    return;
  }
  expect(box.y).toBeGreaterThanOrEqual(frame.y);
  expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
  expect(box.height).toBeGreaterThanOrEqual(24);
}

/** The reveal button stays clear of the typed value, inside the end padding the field reserves. */
async function expectClearOfValue(control: Locator, field: Locator) {
  const [box, frame, padding] = await Promise.all([
    control.boundingBox(),
    field.boundingBox(),
    field.evaluate((element) => parseFloat(getComputedStyle(element).paddingRight)),
  ]);
  if (!box || !frame) {
    throw new Error('The password field or its reveal button has no box');
  }
  expect(box.x).toBeGreaterThanOrEqual(frame.x + frame.width - padding);
}

/** The reset request form's resting label sits in the middle of the field at any height. */
async function expectResetLabelCentered(page: Page) {
  await page.goto('/forgot-password');
  const field = page.getByRole('textbox', { name: /email/i });
  await expect(field).toBeVisible({ timeout: 20000 });
  const label = page.locator('label[for="email"]');
  await expectWithin(label, field);
  const [box, frame] = await Promise.all([label.boundingBox(), field.boundingBox()]);
  if (!box || !frame) {
    throw new Error('The reset request field or its label has no box');
  }
  const offset = box.y + box.height / 2 - (frame.y + frame.height / 2);
  expect(Math.abs(offset)).toBeLessThanOrEqual(2);
}

test.describe('sign-in control shape roles', () => {
  test('the stock theme keeps the sign-in field, button and corner it always drew @scenario:sign-in-controls-keep-default-shape', async ({
    page,
  }) => {
    await openLogin(page);
    await expectShape(page, { field: 44, button: 48, radius: '16px' });
    await expectResetLabelCentered(page);
  });

  test('the ClickHouse theme draws the sign-in controls at its own height and corner @scenario:clickhouse-reshapes-sign-in-controls', async ({
    page,
  }) => {
    await serveTheme(page, 'clickhouse');
    await openLogin(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    await expectShape(page, { field: 32, button: 32, radius: '4px' });
    await expectResetLabelCentered(page);
  });

  test('a theme that names the sign-in roles reshapes the controls without touching the form @scenario:theme-reshapes-sign-in-controls', async ({
    page,
  }) => {
    await serveTheme(page, REFERENCE_THEME);
    await openLogin(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', REFERENCE_THEME.name);
    await expectShape(page, { field: 56, button: 40, radius: '0px' });
    await expectResetLabelCentered(page);
  });
});
