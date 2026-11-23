import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The sign-in field's label shrinks into the field's top edge on focus. It scales from its
 * inline-start corner, so in RTL it shrinks toward the right edge it starts from and stays inside
 * the field instead of being pushed past it.
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function focusedLabel(page: Page, dir: 'ltr' | 'rtl') {
  await page.goto('/login');
  await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 20000 });
  await page.evaluate((value) => {
    document.documentElement.dir = value;
  }, dir);
  const input = page.locator('input#email');
  await input.focus();
  const label = page.locator('label[for="email"]');
  /** Reads once the scale transition settles. */
  let previous = '';
  await expect
    .poll(async () => {
      const next = JSON.stringify(
        await label.evaluate((node) => {
          const field = (document.getElementById('email') as HTMLElement).getBoundingClientRect();
          const box = node.getBoundingClientRect();
          return {
            fromLeft: Math.round(box.left - field.left),
            fromRight: Math.round(field.right - box.right),
          };
        }),
      );
      const settled = next === previous;
      previous = next;
      return settled;
    })
    .toBe(true);
  return JSON.parse(previous) as { fromLeft: number; fromRight: number };
}

test('a focused sign-in label stays inside its field on the reading edge in RTL and LTR @scenario:rtl-floating-label-stays-in-field', async ({
  page,
}) => {
  const rtl = await focusedLabel(page, 'rtl');
  expect(rtl.fromRight).toBeGreaterThanOrEqual(0);
  expect(rtl.fromLeft).toBeGreaterThan(rtl.fromRight);

  const ltr = await focusedLabel(page, 'ltr');
  expect(ltr.fromLeft).toBeGreaterThanOrEqual(0);
  expect(ltr.fromRight).toBeGreaterThan(ltr.fromLeft);
});
