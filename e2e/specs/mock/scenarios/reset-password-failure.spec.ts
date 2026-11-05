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
});
