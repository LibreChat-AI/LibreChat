import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import cleanupUser from '../../../setup/cleanupUser';

/**
 * Admin role mutations leave audit entries an operator can read back. The primary user
 * (first registered, ADMIN) creates, edits and deletes a role this file owns, then reads
 * the audit log filtered by the role name.
 */

type AuditEntry = { action: string; outcome: string; target?: { id?: string; name?: string } };

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

async function auditActions(
  request: APIRequestContext,
  headers: Record<string, string>,
  roleName: string,
): Promise<string[]> {
  const res = await request.get('/api/admin/audit-log', {
    headers,
    params: { search: roleName, limit: 50 },
  });
  expect(res.ok()).toBeTruthy();
  const { entries } = (await res.json()) as { entries: AuditEntry[] };
  return entries.filter((e) => JSON.stringify(e).includes(roleName)).map((e) => e.action);
}

test.describe('admin role audit trail', () => {
  test('creating, editing and deleting a role is recorded in the audit log @scenario:role-lifecycle-is-audited', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roleName = `audit-role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const headers = await adminHeaders(request);

      const created = await request.post('/api/admin/roles', { headers, data: { name: roleName } });
      expect(created.status()).toBe(201);

      const updated = await request.patch(`/api/admin/roles/${roleName}`, {
        headers,
        data: { description: 'audited role' },
      });
      expect(updated.ok()).toBeTruthy();

      const deleted = await request.delete(`/api/admin/roles/${roleName}`, { headers });
      expect(deleted.ok()).toBeTruthy();

      const actions = await auditActions(request, headers, roleName);
      expect(actions).toEqual(
        expect.arrayContaining(['role.created', 'role.updated', 'role.deleted']),
      );
    } finally {
      await request.dispose();
    }
  });

  test('a rejected role mutation leaves no created entry @scenario:rejected-role-create-is-not-audited', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roleName = `audit-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const headers = await adminHeaders(request);
      const first = await request.post('/api/admin/roles', { headers, data: { name: roleName } });
      expect(first.status()).toBe(201);
      const duplicate = await request.post('/api/admin/roles', {
        headers,
        data: { name: roleName },
      });
      expect(duplicate.status()).toBe(409);

      const actions = await auditActions(request, headers, roleName);
      expect(actions.filter((a) => a === 'role.created')).toHaveLength(1);

      await request.delete(`/api/admin/roles/${roleName}`, { headers });
    } finally {
      await request.dispose();
    }
  });

  test('a non-admin user cannot read the audit log or manage roles @scenario:non-admin-denied-role-and-audit-endpoints', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const user = {
      email: `audit-nonadmin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      name: 'Audit Non Admin',
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
      const { token } = (await login.json()) as { token: string };
      const headers = { Authorization: `Bearer ${token}` };

      expect((await request.get('/api/admin/audit-log', { headers })).status()).toBe(403);
      const create = await request.post('/api/admin/roles', {
        headers,
        data: { name: 'audit-denied' },
      });
      expect(create.status()).toBe(403);
    } finally {
      await request.dispose();
      await cleanupUser(user);
    }
  });
});
