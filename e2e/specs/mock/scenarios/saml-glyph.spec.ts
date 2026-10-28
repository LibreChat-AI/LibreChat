import { expect, test } from '@playwright/test';

/**
 * The SAML sign-in button draws a generic key glyph. It used to be filled black, which vanished
 * on the dark login surface; it now takes the button's own text colour, so it reads in every
 * mode and theme. SAML is switched on by rewriting `/api/config` the way librechat.yaml would.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test('the SAML sign-in glyph is painted with the button text colour @scenario:saml-login-glyph-follows-button-text', async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          socialLoginEnabled: true,
          samlLoginEnabled: true,
          samlImageUrl: '',
          samlLabel: 'SAML',
          socialLogins: ['saml'],
        },
      });
    },
  );

  await page.goto('/login', { timeout: 15_000 });
  const button = page.getByRole('link', { name: 'SAML' });
  await expect(button).toBeVisible({ timeout: 15_000 });

  const paint = await button.evaluate((link) => {
    const glyph = link.querySelector('svg g');
    return {
      text: getComputedStyle(link).color,
      glyph: glyph ? getComputedStyle(glyph).fill : null,
    };
  });
  expect(paint.glyph).toBe(paint.text);
});
