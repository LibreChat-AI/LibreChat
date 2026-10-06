import { expect, test } from '@playwright/test';

/**
 * The sign-in screens compose the shared `Input`, `SecretInput`, `Button` and `Alert` through
 * named roles (`variant="floating"`, `size="xl"` with `shape="soft"`, `size="roomy"`) instead of
 * restating classes per screen. These scenarios read what the browser paints in the default theme,
 * so the roles have to reproduce the look the local class strings drew.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const MODES = ['light', 'dark'] as const;

for (const mode of MODES) {
  test.describe(`${mode} mode`, () => {
    test.use({ colorScheme: mode });

    test(`a sign-in field keeps its rounded edge and its label rests inside it until it has a value (${mode}) @scenario:signin-floating-field`, async ({
      page,
    }) => {
      await page.goto('/login', { timeout: 15_000 });
      const email = page.locator('#email');
      await expect(email).toBeVisible({ timeout: 15_000 });

      const field = await email.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          radius: style.borderTopLeftRadius,
          padLeft: style.paddingLeft,
          width: el.getBoundingClientRect().width,
          wrapperWidth: el.parentElement?.getBoundingClientRect().width ?? 0,
        };
      });
      expect(field.radius).toBe('16px');
      expect(field.padLeft).toBe('14px');
      expect(field.width).toBe(field.wrapperWidth);

      const label = page.locator('label[for="email"]');
      const resting = await label.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
      expect(resting).toBe(1);

      await email.fill('someone@example.com');
      const lifted = await label.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
      expect(lifted).toBeCloseTo(0.75, 2);

      const password = page.locator('#password');
      await expect(password).toHaveAttribute('placeholder', ' ');
      expect(await password.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe(
        '16px',
      );
      await expect(page.getByRole('button', { name: /show/i })).toBeVisible();
    });

    test(`the sign-in submit is a 48px control with a 16px corner (${mode}) @scenario:signin-submit-shape`, async ({
      page,
    }) => {
      await page.goto('/login', { timeout: 15_000 });
      const submit = page.getByTestId('login-button');
      await expect(submit).toBeVisible({ timeout: 15_000 });

      const box = await submit.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          radius: style.borderTopLeftRadius,
          wrapperWidth: el.parentElement?.getBoundingClientRect().width ?? 0,
          width: el.getBoundingClientRect().width,
        };
      });
      expect(box.height).toBe(48);
      expect(box.radius).toBe('16px');
      expect(box.width).toBe(box.wrapperWidth);
    });

    test(`a failed sign-in shows its error with the roomy alert padding (${mode}) @scenario:signin-error-alert`, async ({
      page,
    }) => {
      await page.route(
        (url) => url.pathname === '/api/auth/login',
        (route) => route.fulfill({ status: 401, json: { message: 'Invalid email or password' } }),
      );
      await page.goto('/login', { timeout: 15_000 });
      await page.locator('#email').fill('someone@example.com');
      await page.locator('#password').fill('not-the-password');
      await page.getByTestId('login-button').click();

      const alert = page.getByRole('alert').filter({ hasText: /./ }).first();
      await expect(alert).toBeVisible({ timeout: 15_000 });
      const padding = await alert.evaluate((el) => {
        const style = getComputedStyle(el);
        return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
      });
      expect(padding).toEqual(['16px', '24px', '16px', '24px']);
    });
  });
}
