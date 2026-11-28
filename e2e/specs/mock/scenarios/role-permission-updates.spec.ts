import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';

/**
 * `PUT /api/roles/:roleName/<type>` writes only the flags it was sent. The primary user
 * (first registered, ADMIN) owns a role this file creates and deletes.
 */

type Flags = Record<string, boolean | undefined>;
type RoleBody = { name: string; permissions?: Record<string, Flags | undefined> };

async function adminHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const user = getPrimaryE2EUser();
  const res = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok()).toBeTruthy();
  const { token } = (await res.json()) as { token: string };
  expect(token).toBeTruthy();
  return { Authorization: `Bearer ${token}` };
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readRole(
  request: APIRequestContext,
  headers: Record<string, string>,
  roleName: string,
): Promise<RoleBody> {
  const res = await request.get(`/api/roles/${roleName}`, { headers });
  expect(res.status()).toBe(200);
  return (await res.json()) as RoleBody;
}

test.describe('role permission updates', () => {
  test('concurrent updates to two permission types of one role both persist @scenario:concurrent-role-permission-types-persist', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roleName = uniqueName('perm-race');
    let headers: Record<string, string> = {};
    try {
      headers = await adminHeaders(request);
      const created = await request.post('/api/admin/roles', { headers, data: { name: roleName } });
      expect(created.status()).toBe(201);

      for (let round = 0; round < 8; round++) {
        const value = round % 2 === 0;
        const [prompts, agents] = await Promise.all([
          request.put(`/api/roles/${roleName}/prompts`, { headers, data: { CREATE: value } }),
          request.put(`/api/roles/${roleName}/agents`, { headers, data: { USE: !value } }),
        ]);
        expect(prompts.status()).toBe(200);
        expect(agents.status()).toBe(200);

        const role = await readRole(request, headers, roleName);
        expect(role.permissions?.PROMPTS?.CREATE).toBe(value);
        expect(role.permissions?.AGENTS?.USE).toBe(!value);
      }
    } finally {
      await request.delete(`/api/admin/roles/${roleName}`, { headers }).catch(() => undefined);
      await request.dispose();
    }
  });

  test('an update changes only the flags it sends and answers with the stored role @scenario:role-permission-update-keeps-other-flags', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roleName = uniqueName('perm-keep');
    let headers: Record<string, string> = {};
    try {
      headers = await adminHeaders(request);
      const created = await request.post('/api/admin/roles', { headers, data: { name: roleName } });
      expect(created.status()).toBe(201);

      const base = await request.put(`/api/roles/${roleName}/prompts`, {
        headers,
        data: { USE: true, CREATE: true },
      });
      expect(base.status()).toBe(200);
      const agents = await request.put(`/api/roles/${roleName}/agents`, {
        headers,
        data: { USE: true },
      });
      expect(agents.status()).toBe(200);

      const res = await request.put(`/api/roles/${roleName}/prompts`, {
        headers,
        data: { CREATE: false },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as RoleBody;
      expect(body.name).toBe(roleName);
      expect(body.permissions?.PROMPTS).toEqual(
        expect.objectContaining({ USE: true, CREATE: false }),
      );
      expect(body.permissions?.AGENTS?.USE).toBe(true);

      const stored = await readRole(request, headers, roleName);
      expect(stored.permissions?.PROMPTS).toEqual(
        expect.objectContaining({ USE: true, CREATE: false }),
      );
      expect(stored.permissions?.AGENTS?.USE).toBe(true);
    } finally {
      await request.delete(`/api/admin/roles/${roleName}`, { headers }).catch(() => undefined);
      await request.dispose();
    }
  });

  test('an update to a deleted role answers 404 and does not recreate it @scenario:role-permission-update-missing-role-404', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roleName = uniqueName('perm-gone');
    try {
      const headers = await adminHeaders(request);
      const created = await request.post('/api/admin/roles', { headers, data: { name: roleName } });
      expect(created.status()).toBe(201);
      const deleted = await request.delete(`/api/admin/roles/${roleName}`, { headers });
      expect(deleted.ok()).toBeTruthy();

      const res = await request.put(`/api/roles/${roleName}/prompts`, {
        headers,
        data: { USE: true },
      });
      expect(res.status()).toBe(404);
      expect(await res.json()).toEqual({ message: 'Role not found' });

      const read = await request.get(`/api/roles/${roleName}`, { headers });
      expect(read.status()).toBe(404);
    } finally {
      await request.dispose();
    }
  });
});
