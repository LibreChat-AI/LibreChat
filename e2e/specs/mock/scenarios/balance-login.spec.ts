import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/**
 * The sign-in balance sync resolves config for the signing-in user, not only their role.
 * e2e/config/librechat.e2e.yaml has no `balance` block, so balance is enabled here by a
 * user-scoped override alone: the record written during `POST /api/auth/login` exists, and
 * carries the override's values, only when the login route consults that user's overrides.
 */

const refillAmount = 30000000;

const targetUser = {
  email: `balance-login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: 'Balance Login Target',
  password: 'securepassword789',
};

async function login(
  request: APIRequestContext,
  user: { email: string; password: string },
): Promise<{ headers: Record<string, string>; userId: string }> {
  const res = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok()).toBeTruthy();
  const { token, user: body } = (await res.json()) as {
    token: string;
    user: { id?: string; _id?: string };
  };
  const userId = body.id ?? body._id;
  expect(userId).toBeTruthy();
  return { headers: { Authorization: `Bearer ${token}` }, userId: userId as string };
}

test.describe('Sign-in balance sync', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/auth/register', {
      data: { ...targetUser, confirm_password: targetUser.password },
    });
    expect(res.ok()).toBeTruthy();
  });

  test.afterAll(async () => {
    await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email: targetUser.email });
      if (!user) {
        return;
      }
      await db.collection('configs').deleteMany({ principalId: user._id.toString() });
      await db.collection('balances').deleteMany({ user: user._id });
      await db.collection('users').deleteOne({ _id: user._id });
    });
  });

  test('a user balance override is applied by the sign-in sync @scenario:balance-login-user-override', async ({
    request,
  }) => {
    const admin = await login(request, getPrimaryE2EUser());
    const user = await withMongo((db) =>
      db.collection('users').findOne({ email: targetUser.email }),
    );
    expect(user).toBeTruthy();
    const userId = user!._id;

    const put = await request.put(`/api/admin/config/user/${userId.toString()}`, {
      headers: admin.headers,
      data: {
        overrides: {
          balance: {
            enabled: true,
            startBalance: 1000,
            autoRefillEnabled: true,
            refillIntervalValue: 30,
            refillIntervalUnit: 'days',
            refillAmount,
          },
        },
      },
    });
    expect(put.ok()).toBeTruthy();
    await withMongo((db) => db.collection('balances').deleteMany({ user: userId }));

    await login(request, targetUser);

    const record = await withMongo((db) => db.collection('balances').findOne({ user: userId }));
    expect(record?.refillAmount).toBe(refillAmount);
    expect(record?.autoRefillEnabled).toBe(true);
  });
});
