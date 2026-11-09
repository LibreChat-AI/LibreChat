import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/**
 * `fileConfig.stt`, written as a principal config override by the primary user (first
 * registered, ADMIN) for a user this file registers, whose own requests read the merged result.
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

/** A user owned by this file, so no other spec's cleanup can remove it mid-run. */
const targetUser = {
  email: `config-keys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: 'Config Keys Target',
  password: 'securepassword789',
};

let cachedSessions: { admin: Session; target: Session } | undefined;

/** Logs in once per worker: the harness allows 20 logins per window across all specs. */
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

async function clearOverrides(
  request: APIRequestContext,
  admin: Session,
  userId: string,
): Promise<void> {
  const res = await request.delete(configPath(userId), { headers: admin.headers });
  expect([200, 204, 404]).toContain(res.status());
}

test.describe('fileConfig.stt', () => {
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

  test('an invalid fileConfig.stt MIME pattern is rejected when written @scenario:file-config-stt-validated', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      const res = await request.put(configPath(target.userId), {
        headers: admin.headers,
        data: { overrides: { fileConfig: { stt: { supportedMimeTypes: ['('] } } } },
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { code: string; issues: Array<{ path: string }> };
      expect(body.code).toBe('CONFIG_OVERRIDE_INVALID');
      expect(body.issues.map((issue) => issue.path)).toEqual([
        'fileConfig.stt.supportedMimeTypes.0',
      ]);
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });

  test('a valid fileConfig.stt list reaches the user file config @scenario:file-config-stt-applied', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      const put = await request.put(configPath(target.userId), {
        headers: admin.headers,
        data: { overrides: { fileConfig: { stt: { supportedMimeTypes: ['^audio/ogg$'] } } } },
      });
      expect(put.status(), await put.text()).toBe(201);

      await expect
        .poll(
          async () => {
            const res = await request.get('/api/files/config', { headers: target.headers });
            expect(res.ok()).toBeTruthy();
            const body = (await res.json()) as { stt?: { supportedMimeTypes?: string[] } };
            return body.stt;
          },
          { timeout: 30000, intervals: [500, 1000, 2000] },
        )
        .toEqual({ supportedMimeTypes: ['^audio/ogg$'] });
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });
});
