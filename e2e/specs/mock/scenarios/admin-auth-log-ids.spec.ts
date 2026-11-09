import { randomBytes, randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import cleanupUser from '../../../setup/cleanupUser';

/**
 * The admin panel auth flow logs user ids instead of emails. The success paths that
 * log (OAuth callback, code exchange, token refresh) need a live identity provider, so
 * the log content itself is covered by the unit specs; these exercise the reachable
 * edges of the same flow and check that no response carries the user's email.
 */

test.describe('admin panel auth after log id change', () => {
  test('an unknown admin exchange code is rejected without user data @scenario:admin-exchange-unknown-code-rejected', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const response = await request.post('/api/admin/oauth/exchange', {
        data: { code: randomBytes(32).toString('hex') },
      });
      expect(response.status()).toBe(401);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error_code).toBe('INVALID_OR_EXPIRED_CODE');
      expect(body).not.toHaveProperty('token');
      expect(body).not.toHaveProperty('user');
    } finally {
      await request.dispose();
    }
  });

  test('a non-admin user is denied the admin panel without echoing their email @scenario:admin-verify-non-admin-denied', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const user = {
      email: `admin-log-ids-${randomUUID().slice(0, 8)}@example.com`,
      name: 'Admin Log Ids',
      password: 'securepassword789',
    };
    try {
      const register = await request.post('/api/auth/register', {
        data: { ...user, confirm_password: user.password },
      });
      expect(register.ok()).toBeTruthy();

      const login = await request.post('/api/auth/login', {
        data: { email: user.email, password: user.password },
      });
      expect(login.ok()).toBeTruthy();
      const { token } = (await login.json()) as { token: string };
      expect(token).toBeTruthy();

      const response = await request.get('/api/admin/verify', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status()).toBe(403);
      expect(await response.text()).not.toContain(user.email);
    } finally {
      await request.dispose();
      await cleanupUser(user);
    }
  });
});
