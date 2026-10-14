import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';

const PASSWORD = 'Deletion-Scenario-1!';

test.describe('account deletion', () => {
  test('a user who deletes their account is signed out and cannot sign back in @scenario:account-deletion-succeeds', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const email = `deletion-${randomUUID().slice(0, 8)}@example.com`;
      const register = await request.post('/api/auth/register', {
        data: {
          email,
          name: 'Deletion Scenario',
          password: PASSWORD,
          confirm_password: PASSWORD,
        },
      });
      expect(register.ok()).toBeTruthy();
      const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
      expect(login.ok()).toBeTruthy();
      const { token } = (await login.json()) as { token: string };
      const headers = { Authorization: `Bearer ${token}` };

      const deletion = await request.delete('/api/user/delete', { headers });
      expect(deletion.status()).toBe(200);
      expect(await deletion.json()).toEqual({ message: 'User deleted' });

      expect((await request.get('/api/user', { headers })).status()).toBe(401);
      const relogin = await request.post('/api/auth/login', {
        data: { email, password: PASSWORD },
      });
      expect(relogin.ok()).toBeFalsy();
    } finally {
      await request.dispose();
    }
  });
});
