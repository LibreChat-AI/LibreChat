import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { clearMailbox, getVerificationURL, waitForMessage } from '../../setup/mailbox';
import { getEmailChangeTarget, getEmailChangeUser } from '../../setup/users.email';

test.describe('account settings · registered email', () => {
  test('changes a verified email through the delivered link and notifies both addresses', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    if (!baseURL) {
      throw new Error('Email change E2E test requires a baseURL');
    }

    const user = getEmailChangeUser();
    const newEmail = getEmailChangeTarget();
    await clearMailbox();

    await page.goto('/c/new');
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Account' }).click();
    await page
      .getByRole('tabpanel', { name: 'Account' })
      .getByRole('button', { name: 'Change email address' })
      .click();

    const accessibilityScan = await new AxeBuilder({ page })
      .include('#change-email-dialog')
      .analyze();
    expect(accessibilityScan.violations).toEqual([]);

    await page.getByLabel('New email address').fill(newEmail);
    const currentPasswordInput = page.getByLabel('Current password');
    await expect(currentPasswordInput).toHaveAttribute('type', 'password');
    const showSecretButton = page.getByRole('button', { name: 'Show secret' });
    await showSecretButton.focus();
    await page.keyboard.press('Enter');
    await expect(currentPasswordInput).toHaveAttribute('type', 'text');
    const hideSecretButton = page.getByRole('button', { name: 'Hide secret' });
    await hideSecretButton.focus();
    await page.keyboard.press('Enter');
    await expect(currentPasswordInput).toHaveAttribute('type', 'password');
    await currentPasswordInput.fill(user.password);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/user/email/change',
    );
    await page.getByRole('button', { name: 'Send verification link' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(
      page.getByText('Check your new email address for a verification link.', { exact: true }),
    ).toBeVisible();

    const attemptEmail = await waitForMessage({
      to: user.email,
      subject: 'Email change requested',
    });
    expect(attemptEmail.body).toContain(newEmail);
    expect(attemptEmail.body).toContain('IP address:');

    const verificationEmail = await waitForMessage({
      to: newEmail,
      subject: 'Verify your new email address',
    });
    const verificationURL = getVerificationURL(verificationEmail, baseURL);
    expect(new URL(verificationURL).searchParams.get('type')).toBe('email-change');

    await page.goto(verificationURL);
    await expect(
      page.getByRole('heading', { name: /Email address changed successfully/ }),
    ).toBeVisible();

    const [oldConfirmation, newConfirmation] = await Promise.all([
      waitForMessage({ to: user.email, subject: 'Your email address was changed' }),
      waitForMessage({ to: newEmail, subject: 'Your email address was changed' }),
    ]);
    for (const confirmation of [oldConfirmation, newConfirmation]) {
      expect(confirmation.body).toContain(user.email);
      expect(confirmation.body).toContain(newEmail);
      expect(confirmation.body).toContain('IP address:');
    }

    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Email').fill(newEmail);
    await page.getByLabel('Password').fill(user.password);
    await page.getByTestId('login-button').click();
    await expect(page).toHaveURL(/\/c\/new$/);

    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Account' }).click();
    await expect(
      page.getByRole('tabpanel', { name: 'Account' }).getByText(newEmail, { exact: true }),
    ).toBeVisible();
  });
});
