import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';
import type { TStartupConfig, TUser } from 'librechat-data-provider';
import { NEW_CHAT_PATH } from '../helpers';
import { seedConversations, seedMessages } from '../db';
import { loginAdmin } from '../content-filters.helpers';

/**
 * Acceptance scenarios for deployment-wide 2FA enforcement. The mock harness starts the server
 * with ENFORCE_TWO_FACTOR_AUTHENTICATION disabled (an inherited deployment .env would otherwise
 * hold every other spec's user out of the app), so each policy response is produced at the route
 * boundary exactly as the server emits it under enforcement, matching two-factor-required.spec.ts.
 */

/** No query string: the setup credential is handed over out of band, never through the URL. */
const SETUP_ROUTE_PATTERN = /\/login\/2fa\/setup$/;
/** Enforcement redirects park the destination in the query, so the route may carry one. */
const SETUP_URL_PATTERN = /\/login\/2fa\/setup(?:\?[^#]*)?$/;
const LOGIN_ROUTE_PATTERN = /\/login$/;
const SETUP_TOKEN_STORAGE_KEY = 'two_factor_setup_token';

const ENFORCEMENT_PAYLOAD = {
  code: 'TWO_FACTOR_ENROLLMENT_REQUIRED',
  twoFAPending: true,
  twoFASetupRequired: true,
  tempToken: 'scenario-setup-token',
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

test.describe('required two-factor enrollment · unauthenticated arrival', () => {
  /** The PWA service worker serves API GETs itself, which would bypass every `page.route` below. */
  test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });

  test('a password login hands an unenrolled user to setup instead of a session @scenario:required-2fa-login-hands-off-setup', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60000);
    await page.route('**/api/auth/login', (route) => json(route, ENFORCEMENT_PAYLOAD));

    await page.goto('/login');
    await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
    await page.getByRole('textbox', { name: 'Password' }).fill('password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(SETUP_ROUTE_PATTERN);
    expect(page.url()).not.toContain('tempToken');
    expect(
      await page.evaluate((key) => window.sessionStorage.getItem(key), SETUP_TOKEN_STORAGE_KEY),
    ).toBe('scenario-setup-token');
    await expect(page.getByRole('button', { name: 'Generate QR Code' })).toBeVisible();
    await testInfo.attach('required-two-factor-setup', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });

  test('completing enrollment lands on the original deep link @scenario:required-2fa-enrollment-preserves-deep-link', async ({
    page,
    request,
  }) => {
    test.setTimeout(90000);
    /** The separate API cookie jar leaves the browser unauthenticated until finalization. */
    const authToken = await loginAdmin(request);
    const userResponse = await request.get('/api/user', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(userResponse.ok()).toBe(true);
    const enrolledUser = { ...((await userResponse.json()) as TUser), twoFactorEnabled: true };
    /** A real destination lets the app load it instead of correctly redirecting a missing chat. */
    const conversationId = randomUUID();
    const deepLink = `/c/${conversationId}?source=required-2fa-test`;
    const deepLinkPattern = new RegExp(`/c/${conversationId}\\?source=required-2fa-test$`);
    const transcriptMarker = 'Conversation restored after required two-factor enrollment';
    await seedConversations(enrolledUser.email, [
      { conversationId, title: 'Required enrollment destination', updatedAt: new Date() },
    ]);
    await seedMessages(enrolledUser.email, conversationId, [
      {
        messageId: randomUUID(),
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: transcriptMarker,
        isCreatedByUser: false,
        sender: 'Assistant',
      },
    ]);
    /** Flips only once finalization has promoted the enrollment and minted the session. */
    let finalized = false;

    await page.route('**/api/auth/login', (route) => json(route, ENFORCEMENT_PAYLOAD));
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
      await json(route, { token: authToken, user: enrolledUser });
    });
    await page.route('**/api/user', async (route) => {
      if (!finalized) {
        await json(route, { message: 'Unauthorized' }, 401);
        return;
      }
      await json(route, enrolledUser);
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
    await page.route('**/api/auth/2fa/setup/acknowledge', (route) =>
      json(route, { finalizationToken: 'finalization-token' }),
    );
    await page.route('**/api/auth/2fa/setup/finalize', async (route) => {
      finalized = true;
      await json(route, { token: authToken, user: enrolledUser });
    });

    await page.goto(`/login?redirect_to=${encodeURIComponent(deepLink)}`);
    await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
    await page.getByRole('textbox', { name: 'Password' }).fill('password');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(SETUP_ROUTE_PATTERN);
    await page.getByRole('button', { name: 'Generate QR Code' }).click();
    await expect(page.getByRole('img', { name: 'Scan QR Code' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Enter your 2FA code to continue').fill('123456');
    await page.getByRole('button', { name: 'Verify' }).click();

    const completeButton = page.getByRole('button', { name: 'Complete Setup' });
    await expect(completeButton).toBeDisabled();
    await page.getByRole('button', { name: 'Download Backup Codes' }).click();
    await expect(completeButton).toBeEnabled();
    const enrollmentDestination = page.waitForURL(deepLinkPattern);
    await completeButton.click();
    await enrollmentDestination;
    /** The authenticated shell mounts and settles here rather than bouncing back to /login. */
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect(
      page.locator('.message-render').filter({ hasText: transcriptMarker }),
    ).toBeVisible();
    /** Loading a conversation canonicalizes its URL after the complete destination is delivered. */
    await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`));
  });

  test('an expired setup credential returns the user to sign in @scenario:required-2fa-expired-credential-returns-to-signin', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.addInitScript(([key, value]) => window.sessionStorage.setItem(key, value), [
      SETUP_TOKEN_STORAGE_KEY,
      'spent-setup-token',
    ] as const);
    await page.route('**/api/auth/2fa/setup', (route) =>
      json(route, { message: 'Invalid or expired two-factor setup token' }, 401),
    );

    await page.goto('/login/2fa/setup');
    await page.getByRole('button', { name: 'Generate QR Code' }).click();

    /** The screen retires itself rather than replaying a credential the server can never accept. */
    await expect(page).toHaveURL(LOGIN_ROUTE_PATTERN);
    expect(
      await page.evaluate((key) => window.sessionStorage.getItem(key), SETUP_TOKEN_STORAGE_KEY),
    ).toBeNull();
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible();
  });
});

test.describe('required two-factor enrollment · authenticated arrival', () => {
  test('an enforcement 403 moves a loaded app into setup without a reload @scenario:required-2fa-enforcement-403-redirects-loaded-app', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.route('**/api/convos**', (route) => json(route, ENFORCEMENT_PAYLOAD, 403));
    /** Under enforcement the refresh endpoint hands off to setup as well, so the hard navigation
     *  that follows the redirect cannot silently refresh its way back into the app. */
    await page.route('**/api/auth/refresh', (route) => json(route, ENFORCEMENT_PAYLOAD));

    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

    await expect(page).toHaveURL(SETUP_URL_PATTERN, { timeout: 15000 });
    expect(
      await page.evaluate((key) => window.sessionStorage.getItem(key), SETUP_TOKEN_STORAGE_KEY),
    ).toBe('scenario-setup-token');
    await expect(page.getByRole('button', { name: 'Generate QR Code' })).toBeVisible();
  });

  test('a refresh hand-off moves a loaded app into setup @scenario:required-2fa-refresh-response-hands-off-setup', async ({
    page,
  }) => {
    test.setTimeout(60000);
    /** A 401 on a protected query is what drives the client into its refresh-recovery path. */
    await page.route('**/api/convos**', (route) => json(route, { message: 'Unauthorized' }, 401));
    await page.route('**/api/auth/refresh', (route) => json(route, ENFORCEMENT_PAYLOAD));

    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

    await expect(page).toHaveURL(SETUP_URL_PATTERN, { timeout: 15000 });
    expect(
      await page.evaluate((key) => window.sessionStorage.getItem(key), SETUP_TOKEN_STORAGE_KEY),
    ).toBe('scenario-setup-token');
    await expect(page.getByRole('button', { name: 'Generate QR Code' })).toBeVisible();
  });

  test('the Disable 2FA control stays visible and locked with its reason @scenario:required-2fa-disable-control-locked', async ({
    page,
    isMobile,
  }, testInfo) => {
    test.setTimeout(60000);
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = (await response.json()) as TStartupConfig;
      config.twoFactorAuthenticationRequired = true;
      await route.fulfill({ response, json: config });
    });
    await page.route('**/api/user', async (route) => {
      const response = await route.fetch();
      const user = (await response.json()) as { twoFactorEnabled?: boolean };
      user.twoFactorEnabled = true;
      await route.fulfill({ response, json: user });
    });

    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    if (isMobile) {
      await page.getByRole('button', { name: 'Open sidebar' }).click();
    }
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Account' }).click();

    const disableButton = page.getByRole('button', { name: 'Disable 2FA' });
    const tooltipTrigger = page.getByTestId('required-2fa-disable-control');
    await expect(disableButton).toBeVisible();
    await expect(disableButton).toBeDisabled();

    /** The reason reaches keyboard users, not just pointer users. */
    for (let tabCount = 0; tabCount < 20; tabCount++) {
      await page.keyboard.press('Tab');
      if (await tooltipTrigger.evaluate((element) => document.activeElement === element)) {
        break;
      }
    }
    await expect(tooltipTrigger).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveText('Required by administrator');
    await testInfo.attach('required-two-factor-disable-control', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
