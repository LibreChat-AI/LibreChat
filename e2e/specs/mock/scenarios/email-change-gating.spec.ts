import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';

/**
 * Changing the registered address is offered only where it can actually
 * complete: a local account, on a deployment that can deliver mail, with the
 * operator's switch left on. Each of those three is a separate gate, and the
 * two that live in the served startup config are what an operator turns off.
 *
 * The end-to-end delivery flow needs an SMTP mailbox and runs in the dedicated
 * email profile (`npm run e2e:email-change`). What belongs here is the gating
 * either side of it: the control appears when it can work, disappears when the
 * operator disables it, and a deployment that cannot send mail refuses the
 * request instead of leaving the account half-changed. The confirmation page is
 * the other half of that boundary, since its link arrives from outside the app
 * and a stale or forged one must not move an address.
 *
 * The settings dialog scenarios pin the desktop viewport the same way the other
 * settings-modal scenarios do; the confirmation page runs at every viewport.
 */

const user = getE2EUser();

type StartupConfigOverrides = {
  emailEnabled?: boolean;
  allowEmailChange?: boolean;
};

/** Serve the deployment's startup config with these flags, leaving the rest of
 *  the harness config as every other spec reads it. */
async function withStartupConfig(page: Page, overrides: StartupConfigOverrides) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({ response, json: { ...config, ...overrides } });
  });
}

async function openAccountTab(page: Page) {
  await page.goto('/c/new', { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Account' }).click();
}

const changeEmailButton = (page: Page) =>
  page.getByRole('button', { name: 'Change email address' });

test.describe('account settings · registered email gating', () => {
  test.describe('settings dialog', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('a local account is offered the change when delivery is configured @scenario:email-change-offered-to-a-local-account', async ({
      page,
    }) => {
      test.setTimeout(90000);
      await withStartupConfig(page, { emailEnabled: true, allowEmailChange: true });

      await openAccountTab(page);

      await expect(changeEmailButton(page)).toBeVisible({ timeout: 15000 });
      await changeEmailButton(page).click();

      const dialog = page.getByRole('dialog', { name: 'Change email address' });
      await expect(dialog).toBeVisible({ timeout: 10000 });
      await expect(dialog.getByLabel('New email address')).toBeVisible();
      await expect(dialog.getByLabel('Current password')).toBeVisible();
      /** Nothing is sent until both fields carry a value. */
      await expect(dialog.getByRole('button', { name: 'Send verification link' })).toBeDisabled();
    });

    test('the operator can take the change off the Account tab @scenario:email-change-hidden-when-the-operator-disables-it', async ({
      page,
    }) => {
      test.setTimeout(90000);
      await withStartupConfig(page, { emailEnabled: true, allowEmailChange: false });

      await openAccountTab(page);

      /** The tab itself renders, so an empty assertion cannot pass by accident. */
      await expect(page.getByRole('button', { name: 'Delete account' })).toBeVisible({
        timeout: 15000,
      });
      await expect(changeEmailButton(page)).toHaveCount(0);
    });

    test('a deployment without mail delivery refuses the request @scenario:email-change-refused-without-email-delivery', async ({
      page,
    }) => {
      test.setTimeout(90000);
      /** The client is told delivery works; the server this runs against has no
       *  SMTP, which is the mismatch an operator hits after removing it. */
      await withStartupConfig(page, { emailEnabled: true, allowEmailChange: true });

      await openAccountTab(page);
      await changeEmailButton(page).click();

      const dialog = page.getByRole('dialog', { name: 'Change email address' });
      await expect(dialog).toBeVisible({ timeout: 10000 });
      await dialog.getByLabel('New email address').fill('moved@example.com');
      await dialog.getByLabel('Current password').fill(user.password);
      await dialog.getByRole('button', { name: 'Send verification link' }).click();

      await expect(dialog.getByRole('alert')).toHaveText(
        'Email delivery is not configured for this server.',
        { timeout: 15000 },
      );
      /** The dialog stays open and the account never adopts the new address. */
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('moved@example.com')).toHaveCount(0);
    });
  });

  test('a confirmation link the server does not recognise changes nothing @scenario:email-change-link-with-an-unknown-token-is-refused', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const query = new URLSearchParams({
      type: 'email-change',
      userId: '000000000000000000000000',
      email: 'moved@example.com',
      token: 'not-a-real-token',
    });

    await page.goto(`/verify?${query.toString()}`, { timeout: 15000 });

    await expect(page.getByText('Email change verification failed')).toBeVisible({
      timeout: 20000,
    });
    /** A refused link is not an invitation to request a new verification mail. */
    await expect(page.getByRole('button', { name: 'Resend Email' })).toHaveCount(0);
  });
});
