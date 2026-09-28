import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/**
 * Principal config overrides are checked against `configSchema`: an invalid field is
 * rejected when written, and one already stored is ignored when merged, so the
 * `librechat.yaml` value survives. The primary user (first registered, ADMIN) writes
 * overrides for a user this file registers, whose own `/api/config` shows the merged result.
 * `interface.contextCost` is `true` in e2e/config/librechat.e2e.yaml.
 */

type Session = { headers: Record<string, string>; userId: string };
type InterfaceConfig = { contextCost?: unknown; customWelcome?: string };

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
  email: `config-override-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: 'Config Override Target',
  password: 'securepassword789',
};

async function sessions(request: APIRequestContext): Promise<{ admin: Session; target: Session }> {
  const admin = await login(request, getPrimaryE2EUser());
  const target = await login(request, targetUser);
  return { admin, target };
}

function configPath(userId: string): string {
  return `/api/admin/config/user/${userId}`;
}

async function readInterface(
  request: APIRequestContext,
  session: Session,
): Promise<InterfaceConfig> {
  const res = await request.get('/api/config', { headers: session.headers });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { interface?: InterfaceConfig };
  return body.interface ?? {};
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

test.describe('Principal config override validation', () => {
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

  test('an invalid field in a whole-document write is rejected and nothing is stored @scenario:config-override-invalid-put-rejected', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      const res = await request.put(configPath(target.userId), {
        headers: admin.headers,
        data: { overrides: { interface: { contextCost: 'yes', customWelcome: 'rejected' } } },
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { error: string; issues: Array<{ path: string }> };
      expect(body.error).toContain('interface.contextCost');
      expect(body.issues.map((issue) => issue.path)).toEqual(['interface.contextCost']);

      expect(await storedOverrides(request, admin, target.userId)).toBeNull();
      const iface = await readInterface(request, target);
      expect(iface.contextCost).toBe(true);
      expect(iface.customWelcome).not.toBe('rejected');
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });

  test('an invalid field in a field patch is rejected and the stored override is unchanged @scenario:config-override-invalid-patch-rejected', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      const seeded = await request.put(configPath(target.userId), {
        headers: admin.headers,
        data: { overrides: { interface: { customWelcome: 'kept' } } },
      });
      expect(seeded.ok()).toBeTruthy();

      const res = await request.patch(`${configPath(target.userId)}/fields`, {
        headers: admin.headers,
        data: {
          entries: [
            { fieldPath: 'interface.customWelcome', value: 'replaced' },
            { fieldPath: 'interface.contextCost', value: 'yes' },
          ],
        },
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { issues: Array<{ path: string }> };
      expect(body.issues.map((issue) => issue.path)).toEqual(['interface.contextCost']);

      expect(await storedOverrides(request, admin, target.userId)).toEqual({
        interface: { customWelcome: 'kept' },
      });
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });

  test('a valid partial section override is accepted and merged over the base @scenario:config-override-valid-partial-accepted', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    const marker = `welcome-${Date.now()}`;
    try {
      const res = await request.put(configPath(target.userId), {
        headers: admin.headers,
        data: { overrides: { interface: { customWelcome: marker } } },
      });
      expect(res.ok()).toBeTruthy();

      await expect
        .poll(async () => (await readInterface(request, target)).customWelcome, {
          timeout: 30000,
          intervals: [500, 1000, 2000],
        })
        .toBe(marker);
      expect((await readInterface(request, target)).contextCost).toBe(true);
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });

  test('an invalid override already stored leaves the base value in place @scenario:config-override-stored-invalid-keeps-base', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    const marker = `stored-${Date.now()}`;
    try {
      const seeded = await request.put(configPath(target.userId), {
        headers: admin.headers,
        data: { overrides: { interface: { customWelcome: 'seed' } } },
      });
      expect(seeded.ok()).toBeTruthy();

      /** Written straight to the collection, as a document stored before write validation. */
      const written = await withMongo((db) =>
        db
          .collection('configs')
          .updateOne(
            { principalType: 'user', principalId: target.userId },
            { $set: { 'overrides.interface.contextCost': 'yes' } },
          ),
      );
      expect(written.matchedCount).toBe(1);

      /** A valid patch on the same document invalidates the merged-config cache. */
      const patched = await request.patch(`${configPath(target.userId)}/fields`, {
        headers: admin.headers,
        data: { entries: [{ fieldPath: 'interface.customWelcome', value: marker }] },
      });
      expect(patched.ok()).toBeTruthy();

      await expect
        .poll(async () => (await readInterface(request, target)).customWelcome, {
          timeout: 30000,
          intervals: [500, 1000, 2000],
        })
        .toBe(marker);
      expect((await readInterface(request, target)).contextCost).toBe(true);
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });
});
