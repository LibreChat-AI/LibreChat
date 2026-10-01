import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from '@playwright/test';
import { seedPasskey, deleteUserByEmail, countUserPasskeys, enableTwoFactorFlag } from '../db';
import { NEW_CHAT_PATH } from '../helpers';
import { getPrimaryE2EUser } from '../../../setup/users.mock';

/**
 * Passkey sign-in and management, driven through a real WebAuthn ceremony: Chromium's
 * virtual authenticator stands in for the platform authenticator, so the browser
 * creates and signs with an actual credential that the server verifies.
 *
 * Every scenario uses its own throwaway account. Passkeys, password resets and account
 * deletion all change credentials, and the shared e2e user must stay usable for the
 * rest of the suite.
 */

const PASSWORD = 'passkey-e2e-password-1';
const DESKTOP = { width: 1280, height: 800 };

type FreshUser = { email: string; name: string; password: string; id: string; token: string };

type VirtualAuthenticator = {
  cdp: CDPSession;
  authenticatorId: string;
  credentialCount: () => Promise<number>;
};

/** Same server under its `localhost` name: WebAuthn refuses an IP address as the RP ID. */
function passkeyBaseURL(baseURL: string | undefined): string {
  const url = new URL(baseURL as string);
  url.hostname = 'localhost';
  return url.origin;
}

async function createFreshUser(request: APIRequestContext): Promise<FreshUser> {
  const email = `passkey-${randomUUID().slice(0, 8)}@example.com`;
  const name = 'Passkey Scenario';
  const register = await request.post('/api/auth/register', {
    data: { email, name, password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const body = (await login.json()) as { token: string; user: { _id: string; id?: string } };
  return { email, name, password: PASSWORD, id: body.user.id ?? body.user._id, token: body.token };
}

async function openContextFor(
  browser: Browser,
  request: APIRequestContext,
  baseURL: string,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    storageState: await request.storageState(),
    baseURL,
    viewport: DESKTOP,
  });
  await context.addInitScript(() => {
    localStorage.setItem('navVisible', 'true');
  });
  return context;
}

async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const credentialCount = async () =>
    (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length;
  return { cdp, authenticatorId, credentialCount };
}

async function openPasskeysDialog(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const settingsDialog = page.getByRole('dialog', { name: /Settings/ });
  await settingsDialog.getByRole('tab', { name: 'Account' }).click();
  await settingsDialog.getByRole('button', { name: 'Passkeys', exact: true }).click();
  const passkeysDialog = page.getByRole('dialog', { name: 'Passkeys', exact: true });
  await expect(passkeysDialog).toBeVisible();
  return passkeysDialog;
}

async function submitAddPasskey(page: Page, password: string) {
  const passkeysDialog = await openPasskeysDialog(page);
  await passkeysDialog.getByRole('button', { name: 'Add passkey' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add passkey', exact: true });
  await addDialog.getByLabel('Confirm your password').fill(password);
  await addDialog.getByRole('button', { name: 'Confirm' }).click();
  return { passkeysDialog, addDialog };
}

async function addPasskey(page: Page, password: string) {
  const { passkeysDialog, addDialog } = await submitAddPasskey(page, password);
  await expect(addDialog).toBeHidden();
  await expect(passkeysDialog.getByTestId('passkey-item')).toHaveCount(1);
  /** A new passkey opens in rename mode, prefilled with a name derived from its transport. */
  const nameInput = passkeysDialog.getByRole('textbox', { name: 'Passkey name' });
  await expect(nameInput).toHaveValue('This device');
  await passkeysDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(passkeysDialog.getByText('This device', { exact: true })).toBeVisible();
  return passkeysDialog;
}

/** Nested dialogs close one per Escape, each after its exit animation. */
async function closeDialogs(page: Page) {
  const dialogs = page.getByRole('dialog');
  await expect(async () => {
    if ((await dialogs.count()) > 0) {
      await page.keyboard.press('Escape');
    }
    await expect(dialogs).toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 15000 });
}

async function logOut(page: Page) {
  await closeDialogs(page);
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

/**
 * The login page starts a conditional-mediation (autofill) ceremony on load, and
 * Chromium's virtual authenticator answers it without a prompt, so sign-in can finish
 * before the button is pressed. Pressing it otherwise starts the modal ceremony. The
 * outcome the user sees is the same either way, and that is what the scenarios assert.
 */
async function signInWithPasskey(page: Page) {
  const leftLogin = page
    .waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 15000 })
    .catch(() => undefined);
  const pressed = page
    .getByRole('button', { name: 'Sign in with a passkey' })
    .click({ timeout: 15000 })
    .catch(() => undefined);
  await Promise.race([leftLogin, pressed]);
}

test.describe('passkeys', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'virtual authenticator is CDP-only');

  let user: FreshUser | undefined;
  let context: BrowserContext | undefined;

  test.afterEach(async () => {
    await context?.close();
    context = undefined;
    if (user) {
      await deleteUserByEmail(user.email);
      user = undefined;
    }
  });

  test('a passkey added with the account password signs the user in @scenario:passkey-added-with-password-signs-in', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(90000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    const page = await context.newPage();
    const authenticator = await addVirtualAuthenticator(page);

    await addPasskey(page, user.password);
    expect(await authenticator.credentialCount()).toBe(1);
    expect(await countUserPasskeys(user.id)).toBe(1);

    await logOut(page);
    await signInWithPasskey(page);

    await expect(page).toHaveURL(/\/c\//, { timeout: 15000 });
    await expect(page.getByTestId('nav-user')).toBeVisible();
  });

  test('a wrong password refuses to add a passkey @scenario:passkey-add-refused-with-wrong-password', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    const page = await context.newPage();
    const authenticator = await addVirtualAuthenticator(page);

    const { passkeysDialog, addDialog } = await submitAddPasskey(page, 'not-the-password');

    await expect(addDialog.getByRole('alert')).toHaveText('Incorrect password. Please try again.');
    await expect(addDialog.getByLabel('Confirm your password')).toBeFocused();
    await addDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(passkeysDialog.getByTestId('passkey-item')).toHaveCount(0);
    expect(await authenticator.credentialCount()).toBe(0);
    expect(await countUserPasskeys(user.id)).toBe(0);
  });

  test('a removed passkey no longer signs in @scenario:removed-passkey-no-longer-signs-in', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(90000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    const page = await context.newPage();
    const authenticator = await addVirtualAuthenticator(page);

    const passkeysDialog = await addPasskey(page, user.password);
    await passkeysDialog.getByRole('button', { name: 'Remove passkey' }).click();
    const deleteDialog = page.getByRole('alertdialog');
    await deleteDialog.getByLabel('Confirm your password').fill(user.password);
    await deleteDialog.getByRole('button', { name: 'Delete' }).click();
    await expect(deleteDialog).toBeHidden();
    await expect(passkeysDialog.getByText('You have not added any passkeys yet')).toBeVisible();
    /** The authenticator still holds the credential; only the server forgot it. */
    expect(await authenticator.credentialCount()).toBe(1);

    await logOut(page);
    await signInWithPasskey(page);

    /** Both the autofill and the button ceremony are refused, so the toast can appear twice. */
    await expect(page.getByText('Passkey sign-in failed. Please try again.').first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a renamed passkey keeps its name after a reload @scenario:renamed-passkey-keeps-its-name-after-reload', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    await seedPasskey(user.email, `e2e-rename-${randomUUID()}`, 'Old name');
    const page = await context.newPage();

    let passkeysDialog = await openPasskeysDialog(page);
    await passkeysDialog.getByRole('button', { name: 'Rename passkey' }).click();
    await passkeysDialog.getByRole('textbox', { name: 'Passkey name' }).fill('Clé de voyage');
    await passkeysDialog.getByRole('textbox', { name: 'Passkey name' }).press('Enter');
    await expect(passkeysDialog.getByText('Clé de voyage', { exact: true })).toBeVisible();

    await page.reload({ timeout: 10000 });
    passkeysDialog = await openPasskeysDialog(page);
    await expect(passkeysDialog.getByText('Clé de voyage', { exact: true })).toBeVisible();
    await expect(passkeysDialog.getByText('Old name', { exact: true })).toHaveCount(0);
  });

  test('passkey sign-in is offered on the login page only @scenario:passkey-sign-in-offered-only-on-login', async ({
    browser,
    baseURL,
  }) => {
    context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();

    await page.goto('/login', { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();

    await page.goto('/register', { timeout: 10000 });
    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
  });

  test('passkey controls disappear when the deployment turns passkeys off @scenario:passkey-controls-hidden-when-disabled', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    await context.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, passkeyLoginEnabled: false } });
    });
    const page = await context.newPage();

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const settingsDialog = page.getByRole('dialog', { name: /Settings/ });
    await settingsDialog.getByRole('tab', { name: 'Account' }).click();
    await expect(settingsDialog.getByRole('tabpanel')).toBeVisible();
    await expect(settingsDialog.getByRole('button', { name: 'Passkeys', exact: true })).toHaveCount(
      0,
    );

    await logOut(page);
    await expect(page.getByTestId('login-button')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
  });

  test('with email login off, passkey sign-in and management both stay @scenario:passkey-management-stays-when-email-login-off', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    await seedPasskey(user.email, `e2e-email-off-${randomUUID()}`, 'Office key');
    await context.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, emailLoginEnabled: false } });
    });
    const page = await context.newPage();

    const passkeysDialog = await openPasskeysDialog(page);
    await expect(passkeysDialog.getByText('Office key', { exact: true })).toBeVisible();

    await logOut(page);
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  });

  test('a passkey sign-in on a 2FA account asks for the second factor @scenario:passkey-sign-in-hands-off-to-2fa', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(90000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    const page = await context.newPage();
    await addVirtualAuthenticator(page);

    await addPasskey(page, user.password);
    await enableTwoFactorFlag(user.email);
    await logOut(page);
    await signInWithPasskey(page);

    await expect(page).toHaveURL(/\/login\/2fa\?tempToken=/, { timeout: 15000 });
    await expect(
      page.getByText('Check your preferred one-time password application for a code'),
    ).toBeVisible();
    await expect(page.getByTestId('nav-user')).toHaveCount(0);
  });

  test('a password reset revokes earlier access tokens and removes passkeys @scenario:password-reset-revokes-tokens-and-passkeys', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    try {
      user = await createFreshUser(request);
      await seedPasskey(user.email, `e2e-reset-${randomUUID()}`, 'Laptop');
      const authorized = { Authorization: `Bearer ${user.token}` };
      expect((await request.get('/api/user', { headers: authorized })).status()).toBe(200);

      const resetRequest = await request.post('/api/auth/requestPasswordReset', {
        data: { email: user.email },
      });
      expect(resetRequest.ok()).toBeTruthy();
      const { link } = (await resetRequest.json()) as { link?: string };
      expect(link).toBeTruthy();
      const resetUrl = new URL(link as string);
      const newPassword = 'passkey-e2e-password-2';
      const reset = await request.post('/api/auth/resetPassword', {
        data: {
          userId: resetUrl.searchParams.get('userId'),
          token: resetUrl.searchParams.get('token'),
          password: newPassword,
          confirm_password: newPassword,
        },
      });
      expect(reset.ok()).toBeTruthy();

      expect((await request.get('/api/user', { headers: authorized })).status()).toBe(401);
      expect(await countUserPasskeys(user.id)).toBe(0);
    } finally {
      await request.dispose();
    }
  });

  test('deleting the account removes its passkeys @scenario:account-deletion-removes-passkeys', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    try {
      user = await createFreshUser(request);
      await seedPasskey(user.email, `e2e-delete-${randomUUID()}`, 'Phone');
      expect(await countUserPasskeys(user.id)).toBe(1);

      const deletion = await request.delete('/api/user/delete', {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      expect(deletion.ok()).toBeTruthy();
      expect(await countUserPasskeys(user.id)).toBe(0);
    } finally {
      await request.dispose();
    }
  });

  test('a configured per-user cap hides the add control at that cap @scenario:passkey-cap-hides-add-control', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    await seedPasskey(user.email, `e2e-cap-${randomUUID()}`, 'Only key');
    context = await openContextFor(browser, request, passkeyBaseURL(baseURL));
    await request.dispose();
    const page = await context.newPage();

    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, maxPasskeysPerUser: 1 } });
    });

    const cappedDialog = await openPasskeysDialog(page);
    const cappedAdd = cappedDialog.getByRole('button', { name: 'Add passkey' });
    await expect(cappedAdd).toBeVisible();
    await expect(cappedAdd).toBeDisabled();
    await expect(
      cappedDialog.getByText('You have reached the maximum number of passkeys'),
    ).toBeVisible();

    await page.unroute('**/api/config');
    await page.keyboard.press('Escape');
    await expect(cappedDialog).toBeHidden();
    await page
      .getByRole('dialog', { name: /Settings/ })
      .getByRole('button', { name: 'Passkeys', exact: true })
      .click();
    const defaultDialog = page.getByRole('dialog', { name: 'Passkeys', exact: true });
    const defaultAdd = defaultDialog.getByRole('button', { name: 'Add passkey' });
    await expect(defaultAdd).toBeVisible();
    await expect(defaultAdd).toBeEnabled();
    await expect(
      defaultDialog.getByText('You have reached the maximum number of passkeys'),
    ).toHaveCount(0);
  });

  test('the effective user cap reaches startup and both enrollment routes @scenario:passkey-cap-effective-config', async ({
    playwright,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const request = await playwright.request.newContext({ baseURL: passkeyBaseURL(baseURL) });
    user = await createFreshUser(request);
    const headers = { Authorization: `Bearer ${user.token}` };
    const admin = getPrimaryE2EUser();
    const login = await request.post('/api/auth/login', {
      data: { email: admin.email, password: admin.password },
    });
    expect(login.ok()).toBeTruthy();
    const adminHeaders = { Authorization: `Bearer ${(await login.json()).token}` };
    const overridePath = `/api/admin/config/user/${user.id}`;
    try {
      const baseline = await request.get('/api/config', { headers });
      expect((await baseline.json()).maxPasskeysPerUser).toBe(20);
      await seedPasskey(user.email, `e2e-effective-cap-${randomUUID()}`, 'Existing key');
      const saved = await request.put(overridePath, {
        headers: adminHeaders,
        data: { overrides: { passkeys: { perUserMax: 1 } } },
      });
      expect(saved.ok()).toBeTruthy();
      await expect
        .poll(async () => {
          const config = await request.get('/api/config', { headers });
          return (await config.json()).maxPasskeysPerUser;
        })
        .toBe(1);

      for (const path of ['options', 'verify']) {
        const response = await request.post(`/api/auth/passkey/register/${path}`, {
          headers,
          data: { password: user.password, credential: { id: 'over-cap' } },
        });
        expect(response.status()).toBe(409);
        expect(await response.json()).toEqual({ message: 'Passkey limit reached' });
      }
      expect(await countUserPasskeys(user.id)).toBe(1);
      const restored = await request.delete(overridePath, { headers: adminHeaders });
      expect(restored.ok()).toBeTruthy();
      await expect
        .poll(async () => {
          const config = await request.get('/api/config', { headers });
          return (await config.json()).maxPasskeysPerUser;
        })
        .toBe(20);
      const allowed = await request.post('/api/auth/passkey/register/options', {
        headers,
        data: { password: user.password },
      });
      expect(allowed.status()).toBe(200);
    } finally {
      const cleanup = await request.delete(overridePath, { headers: adminHeaders });
      expect([200, 404]).toContain(cleanup.status());
      await request.dispose();
    }
  });
});
