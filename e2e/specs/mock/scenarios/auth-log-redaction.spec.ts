import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';

const GENERIC_RESET_MESSAGE =
  'If an account with that email exists, a password reset link has been sent to it.';

test.describe('auth flows after log redaction', () => {
  test('an unknown address gets the generic password reset reply @scenario:auth-reset-unknown-email-generic-reply', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const response = await request.post('/api/auth/requestPasswordReset', {
        data: { email: `unknown-${randomUUID().slice(0, 8)}@example.com` },
      });
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ message: GENERIC_RESET_MESSAGE });
    } finally {
      await request.dispose();
    }
  });

  test('an invalid registration is rejected with its validation error @scenario:auth-register-validation-error-reported', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const response = await request.post('/api/auth/register', {
        data: {
          email: `short-${randomUUID().slice(0, 8)}@example.com`,
          name: 'Short Password',
          password: 'a',
          confirm_password: 'a',
        },
      });
      expect(response.ok()).toBeFalsy();
      expect(await response.text()).toMatch(/password/i);
    } finally {
      await request.dispose();
    }
  });
});
