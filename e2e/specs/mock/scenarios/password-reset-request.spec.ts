import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { withMongo } from '../db';
import { getE2EUser } from '../../../setup/user';

const GENERIC_RESET_MESSAGE =
  'If an account with that email exists, a password reset link has been sent to it.';

test.describe('password recovery without email delivery', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('shows administrator guidance without collecting an address @scenario:password-reset-without-email-admin-guidance', async ({
    page,
  }) => {
    let requests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/auth/requestPasswordReset')) {
        requests++;
      }
    });
    await page.goto('/forgot-password');

    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'Email delivery is not configured. Contact your administrator to reset your password.',
    );
    await expect(page.getByRole('form', { name: 'Password reset form' })).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to Login' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(requests).toBe(0);
  });

  test('acknowledges known and unknown accounts without token writes @scenario:password-reset-without-email-no-token', async ({
    request,
  }) => {
    const knownEmail = getE2EUser().email;
    const tokenCount = () =>
      withMongo(async (db) => {
        const user = await db.collection('users').findOne({ email: knownEmail });
        expect(user).not.toBeNull();
        return db.collection('tokens').countDocuments({ userId: user!._id });
      });
    const before = await tokenCount();
    for (const email of [knownEmail, `unknown-${randomUUID()}@example.com`]) {
      const response = await request.post('/api/auth/requestPasswordReset', { data: { email } });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ message: GENERIC_RESET_MESSAGE });
    }
    expect(await tokenCount()).toBe(before);
  });
});
