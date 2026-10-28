import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';

/** A non-default destination: reaching it proves the deep link outlived the whole enrollment. */
const DEEP_LINK = '/c/redirect-lifecycle-proof?model=test';
const DEEP_LINK_PATTERN = /\/c\/redirect-lifecycle-proof\?model=test$/;
/** No query string: the setup credential is handed over out of band, never through the URL. */
const SETUP_ROUTE_PATTERN = /\/login\/2fa\/setup$/;

const ENROLLED_USER = {
  id: 'user-1',
  _id: 'user-1',
  name: 'Two Factor User',
  username: 'twofactor',
  email: 'user@example.com',
  provider: 'local',
  role: 'USER',
  emailVerified: true,
  twoFactorEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** The PWA service worker serves API GETs itself, which would bypass every `page.route` below. */
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });

test.describe('required two-factor enrollment', () => {
  test('completes setup after backup acknowledgement and holds the deep link', async ({ page }) => {
    test.setTimeout(60000);
    /** Flips only once finalization has promoted the enrollment and minted the session. */
    let finalized = false;

    await page.route('**/api/auth/login', (route) =>
      json(route, { twoFAPending: true, twoFASetupRequired: true, tempToken: 'setup-token' }),
    );
    /** Before finalization the user holds no refresh session, exactly as the server leaves them
     *  after a required-enrollment login; afterwards the promoted session refreshes normally. */
    await page.route('**/api/auth/refresh', async (route) => {
      if (!finalized) {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: 'Refresh token not provided',
        });
        return;
      }
      await json(route, { token: 'auth-token', user: ENROLLED_USER });
    });
    await page.route('**/api/user', async (route) => {
      if (!finalized) {
        await json(route, { message: 'Unauthorized' }, 401);
        return;
      }
      await json(route, ENROLLED_USER);
    });
    await page.route('**/api/roles/**', (route) => json(route, { name: 'USER', permissions: {} }));
    await page.route('**/api/auth/2fa/setup', (route) =>
      json(route, {
        otpauthUrl: 'otpauth://totp/LibreChat:user@example.com?secret=ABC123&issuer=LibreChat',
        backupCodes: ['backup01', 'backup02'],
      }),
    );
    await page.route('**/api/auth/2fa/setup/confirm', (route) =>
      json(route, {
        backupCodes: ['confirmed-backup01', 'confirmed-backup02'],
        acknowledgementToken: 'acknowledgement-token',
      }),
    );
    await page.route('**/api/auth/2fa/setup/acknowledge', async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        acknowledgementToken: 'acknowledgement-token',
      });
      await json(route, { finalizationToken: 'finalization-token' });
    });
    await page.route('**/api/auth/2fa/setup/finalize', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ finalizationToken: 'finalization-token' });
      finalized = true;
      await json(route, { token: 'auth-token', user: ENROLLED_USER });
    });

    await page.goto(`/login?redirect_to=${encodeURIComponent(DEEP_LINK)}`);
    await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
    await page.getByRole('textbox', { name: 'Password' }).fill('password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(SETUP_ROUTE_PATTERN);
    expect(await page.evaluate(() => window.sessionStorage.getItem('two_factor_setup_token'))).toBe(
      'setup-token',
    );
    await page.reload();
    await expect(page).toHaveURL(SETUP_ROUTE_PATTERN);
    const generateButton = page.getByRole('button', { name: 'Generate QR Code' });
    const setupCardBox = await generateButton.locator('..').boundingBox();
    expect(setupCardBox?.width).toBeGreaterThanOrEqual(430);
    await generateButton.click();

    await expect(page.getByRole('img', { name: 'Scan QR Code' })).toBeVisible();
    await expect(page.getByLabel('Secret Key')).toHaveValue('ABC123');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Enter your 2FA code to continue').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();

    const completeButton = page.getByRole('button', { name: 'Complete Setup' });
    await expect(page).toHaveURL(SETUP_ROUTE_PATTERN);
    await expect(completeButton).toBeDisabled();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Backup Codes' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('backup-codes.txt');
    await expect(completeButton).toBeEnabled();
    await completeButton.click();

    await expect(page).toHaveURL(DEEP_LINK_PATTERN);
    /** The authenticated shell mounts and settles here rather than bouncing back to /login. */
    await expect(page.getByTestId('nav-user')).toBeVisible();
    /** A fixed window is the point: the destination must survive the follow-up auth traffic. */
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(DEEP_LINK_PATTERN);

    /** A reload now authenticates through the refreshed session and stays on the deep link. */
    await page.reload();
    await expect(page.getByTestId('nav-user')).toBeVisible();
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(DEEP_LINK_PATTERN);
  });
});
