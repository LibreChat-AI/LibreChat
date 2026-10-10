import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/**
 * `langfuse` is a tenant-wide section that the generic principal config API
 * strips, so `langfuse.privacy` is set only in `librechat.yaml`: a per-user
 * override can neither weaken nor replace the deployment's privacy mode. The
 * primary user (first registered, ADMIN) writes overrides for a user this file
 * registers.
 */

type Session = { headers: Record<string, string>; userId: string };

async function login(
  request: APIRequestContext,
  user: { email: string; password: string },
): Promise<Session> {
  const res = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok()).toBeTruthy();
  const { token, user: body } = (await res.json()) as {
    token: string;
    user: { id?: string; _id?: string };
  };
  const userId = body.id ?? body._id;
  expect(token).toBeTruthy();
  expect(userId).toBeTruthy();
  return { headers: { Authorization: `Bearer ${token}` }, userId: userId as string };
}

const targetUser = {
  email: `langfuse-privacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: 'Langfuse Privacy Target',
  password: 'securepassword789',
};

let cachedSessions: { admin: Session; target: Session } | undefined;

async function sessions(request: APIRequestContext): Promise<{ admin: Session; target: Session }> {
  if (!cachedSessions) {
    const admin = await login(request, getPrimaryE2EUser());
    const target = await login(request, targetUser);
    cachedSessions = { admin, target };
  }
  return cachedSessions;
}

function configPath(userId: string): string {
  return `/api/admin/config/user/${userId}`;
}

async function storedOverrides(
  request: APIRequestContext,
  admin: Session,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const res = await request.get(configPath(userId), { headers: admin.headers });
  if (res.status() === 404) {
    return null;
  }
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { config?: { overrides?: Record<string, unknown> } };
  return body.config?.overrides ?? {};
}

async function clearOverrides(
  request: APIRequestContext,
  admin: Session,
  userId: string,
): Promise<void> {
  const res = await request.delete(configPath(userId), { headers: admin.headers });
  expect([200, 204, 404]).toContain(res.status());
}

test.describe('Langfuse privacy config override', () => {
  test.describe.configure({ mode: 'serial' });

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
      await db.collection('users').deleteOne({ _id: user._id });
    });
  });

  test('a per-user override cannot change the deployment Langfuse privacy policy @scenario:langfuse-privacy-override-not-stored', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      for (const privacy of [
        { mode: 'full' },
        { mode: 'metricsOnly', redactionText: '[private]' },
      ]) {
        const put = await request.put(configPath(target.userId), {
          headers: admin.headers,
          data: { overrides: { langfuse: { privacy } } },
        });
        expect(put.status()).toBe(200);
        expect(await put.json()).toEqual({ message: 'No actionable override sections provided' });

        const patch = await request.patch(`${configPath(target.userId)}/fields`, {
          headers: admin.headers,
          data: { entries: [{ fieldPath: 'langfuse.privacy.mode', value: privacy.mode }] },
        });
        expect(patch.status()).toBe(200);
        expect(await patch.json()).toEqual({ message: 'No actionable field entries provided' });
      }

      expect(await storedOverrides(request, admin, target.userId)).toBeNull();
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });
});
