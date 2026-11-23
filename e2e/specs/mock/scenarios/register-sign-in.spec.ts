import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const PASSWORD = 'Register-Sign-In-1!';

test.describe('registration hashing', () => {
  test('a newly registered user signs in with their password and not with another @scenario:registered-user-signs-in-with-their-password', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const email = `register-${randomUUID().slice(0, 8)}@example.com`;
      const register = await request.post('/api/auth/register', {
        data: { email, name: 'Register Scenario', password: PASSWORD, confirm_password: PASSWORD },
      });
      expect(register.ok()).toBeTruthy();

      const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
      expect(login.ok()).toBeTruthy();
      const { token } = (await login.json()) as { token: string };
      const headers = { Authorization: `Bearer ${token}` };

      const wrong = await request.post('/api/auth/login', {
        data: { email, password: `${PASSWORD}x` },
        failOnStatusCode: false,
      });
      expect(wrong.ok()).toBeFalsy();

      expect((await request.delete('/api/user/delete', { headers })).status()).toBe(200);
    } finally {
      await request.dispose();
    }
  });
});
