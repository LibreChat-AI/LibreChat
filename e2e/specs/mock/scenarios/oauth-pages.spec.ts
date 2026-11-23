import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The pages an OAuth popup lands on after an MCP, action or pull request sign-in. The success
 * page counts down and closes itself, so the clock is frozen wherever a test needs the page to
 * stay open.
 */

/** Opens a page the way a sign-in does: as a popup of the app window, so `window.close` works. */
async function openPopup(page: Page, path: string) {
  await page.goto('/login', { timeout: 15000 });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate((url) => window.open(url, '_blank', 'width=600,height=700'), path),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  return popup;
}

/**
 * Activates a control that closes its own window. The window can be gone before the input call
 * settles, so that call's rejection counts only while the window is still open.
 */
async function closeWith(popup: Page, activate: () => Promise<void>) {
  const closed = popup.waitForEvent('close');
  await activate().catch((error) => {
    if (!popup.isClosed()) {
      throw error;
    }
  });
  await closed;
}

test('the success page names the server and its Close button closes the popup @scenario:oauth-success-close', async ({
  page,
  context,
}) => {
  await context.clock.install();
  const popup = await openPopup(page, '/oauth/success?serverName=GitHub&flow=flow-a');

  await expect(popup.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(popup.getByText('GitHub', { exact: true })).toBeVisible();
  await expect(popup.getByText('3', { exact: true })).toBeVisible();
  const logoLoaded = await popup
    .locator('header img')
    .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(logoLoaded).toBe(true);

  const close = popup.getByRole('button', { name: 'Close Window' });
  await close.focus();
  await expect(close).toBeFocused();
  await closeWith(popup, () => close.press('Enter'));
});

test('the success page shows no server badge when the redirect names none @scenario:oauth-success-no-server', async ({
  page,
  context,
}) => {
  await context.clock.install();
  const popup = await openPopup(page, '/oauth/success?flow=flow-a');

  await expect(popup.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(popup.getByText('Connected to')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Close Window' })).toBeVisible();
});

test('a long server name stays inside the page @scenario:oauth-success-long-name', async ({
  page,
  context,
}) => {
  await context.clock.install();
  const name = `Ünïcödé 服务器 ${'very-long-action-name-'.repeat(8)}`;
  const popup = await openPopup(page, `/oauth/success?serverName=${encodeURIComponent(name)}`);

  await expect(popup.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(popup.getByText(name)).toBeAttached();
  const overflow = await popup.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the error page explains a known code and falls back for an unknown one @scenario:oauth-error-message', async ({
  page,
}) => {
  const known = await openPopup(page, '/oauth/error?error=invalid_state&flow=flow-a');
  await expect(known.getByRole('heading', { name: 'Authentication Failed' })).toBeVisible();
  await expect(known.getByText('Invalid state parameter. Please try again.')).toBeVisible();
  await known.close();

  const unknown = await openPopup(page, '/oauth/error?error=access_denied');
  await expect(unknown.getByText('Authentication failed. Please try again.')).toBeVisible();
  await expect(unknown.getByText('access_denied')).toHaveCount(0);
  await closeWith(unknown, () => unknown.getByRole('button', { name: 'Close Window' }).click());
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a social login failure still lands on the login screen with its error @scenario:oauth-social-failure-login', async ({
    page,
  }) => {
    /** Passport's `failureRedirect` names no error, unlike the connect callbacks above. */
    await page.goto('/oauth/error', { timeout: 15000 });

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('Email')).toBeVisible();
    /** Exact, so the screen reader announcement that repeats the toast text is not a second match. */
    await expect(
      page.getByText('Authentication failed. Please check your login method and try again.', {
        exact: true,
      }),
    ).toBeVisible();
  });
});
