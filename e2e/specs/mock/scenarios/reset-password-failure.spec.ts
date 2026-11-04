import { expect, test } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { deleteUserByEmail, withMongo } from '../db';

const PASSWORD = 'test1234!';

test.describe('password reset failure', () => {
  /** A reset link is followed signed out; a live harness session would bounce /login to chat. */
  test.use({ storageState: { cookies: [], origins: [] } });

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
    /** The form, not only the URL: a live session passes through /login on its way to chat. */
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test.describe('from a browser still holding a session from before the reset', () => {
    /** A reset page reports the password changed: what it sends to sign-in must not resume the old session. */
    test('signing in after an incomplete reset does not resume the retired session @scenario:reset-incomplete-retires-open-session', async ({
      page,
    }) => {
      await page.context().setExtraHTTPHeaders({
        'X-Forwarded-For': `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
      });
      const email = `reset-incomplete-${randomUUID().slice(0, 8)}@example.com`;
      const register = await page.request.post('/api/auth/register', {
        data: { email, name: 'Reset Incomplete', password: PASSWORD, confirm_password: PASSWORD },
      });
      expect(register.ok()).toBeTruthy();
      try {
        const login = await page.request.post('/api/auth/login', {
          data: { email, password: PASSWORD },
        });
        expect(login.ok()).toBeTruthy();
        expect((await page.request.post('/api/auth/refresh')).ok()).toBeTruthy();

        /** Failure injection: the write committed its cutoff, and retirement after it failed. */
        await page.route('**/api/auth/resetPassword', async (route) => {
          await withMongo((db) =>
            db
              .collection('users')
              .updateOne({ email }, { $set: { credentialsChangedAt: new Date() } }),
          );
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'CREDENTIAL_RETIREMENT_INCOMPLETE' }),
          });
        });
        await page.goto('/reset-password?token=reset-token&userId=0123456789abcdef01234567');
        await page.getByLabel('Password', { exact: true }).fill('Reset-Incomplete-1!');
        await page.getByLabel('Confirm password').fill('Reset-Incomplete-1!');
        await page.getByRole('button', { name: 'Submit registration' }).click();
        await expect(page.getByText('Your new password is active', { exact: false })).toBeVisible();

        const refreshed = page.waitForResponse((response) =>
          response.url().endsWith('/api/auth/refresh'),
        );
        await page.getByRole('button', { name: 'Sign in' }).click();
        expect((await refreshed).ok()).toBe(false);
        await expect(page.getByLabel('Email')).toBeVisible();
        await expect(page).toHaveURL(/\/login/);
      } finally {
        await deleteUserByEmail(email);
      }
    });
  });
});
