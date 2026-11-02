import { expect, test } from '@playwright/test';

test.describe('password reset failure', () => {
  /* A user id that is not an ObjectId makes the token lookup throw a cast error; its text
     names the schema path and value, so the anonymous caller must only see a fixed message. */
  test('a reset that fails unexpectedly returns a fixed message @scenario:reset-failure-hides-internal-error', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const response = await request.post('/api/auth/resetPassword', {
        data: {
          userId: 'not-an-object-id',
          token: 'not-a-token',
          password: 'Reset-Failure-1!',
          confirm_password: 'Reset-Failure-1!',
        },
        failOnStatusCode: false,
      });

      expect(response.status()).toBe(400);
      expect(await response.json()).toEqual({ message: 'Password reset failed' });
    } finally {
      await request.dispose();
    }
  });
  test('a reset that changed the password but not every session says so and offers sign-in @scenario:reset-incomplete-retirement-warns', async ({
    page,
  }) => {
    await page.route('**/api/auth/resetPassword', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'CREDENTIAL_RETIREMENT_INCOMPLETE' }),
      }),
    );
    await page.goto('/reset-password?token=reset-token&userId=0123456789abcdef01234567');

    await page.getByLabel('Password', { exact: true }).fill('Reset-Incomplete-1!');
    await page.getByLabel('Confirm password').fill('Reset-Incomplete-1!');
    await page.getByRole('button', { name: 'Submit registration' }).click();

    await expect(page.getByText('Your new password is active', { exact: false })).toBeVisible();
    await expect(page.getByText('This password reset token is no longer valid.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
