import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import cleanupUser from '../../../setup/cleanupUser';

/**
 * Deleting a custom role audits the accounts the deletion moved to USER, and a role recreated
 * under a deleted role's name starts without the old role's config profile. The primary user
 * (first registered, ADMIN) manages roles and members this file owns.
 */

type AuditEntry = {
  action: string;
  outcome?: string;
  target?: { id?: string; name?: string };
  metadata?: Record<string, unknown>;
};

async function login(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<{ headers: Record<string, string>; userId: string }> {
  const res = await request.post('/api/auth/login', { data: { email, password } });
  expect(res.ok()).toBeTruthy();
  const { token, user } = (await res.json()) as { token: string; user: { _id: string } };
  expect(token).toBeTruthy();
  return { headers: { Authorization: `Bearer ${token}` }, userId: String(user._id) };
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function roleAudit(
  request: APIRequestContext,
  headers: Record<string, string>,
  roleName: string,
): Promise<AuditEntry[]> {
  const res = await request.get('/api/admin/audit-log', {
    headers,
    params: { search: roleName, limit: 50 },
  });
  expect(res.ok()).toBeTruthy();
  const { entries } = (await res.json()) as { entries: AuditEntry[] };
  return entries.filter((e) => JSON.stringify(e).includes(roleName));
}

test.describe('role deletion identity and audit', () => {
  test('deleting a role audits the members it moved to USER @scenario:role-delete-audits-reassigned-members', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const admin = getPrimaryE2EUser();
    const member = {
      email: `${uniqueName('role-member')}@example.com`,
      name: 'Role Member',
      password: 'securepassword789',
    };
    const roleName = uniqueName('delete-audit');
    try {
      const { headers } = await login(request, admin.email, admin.password);
      const register = await request.post('/api/auth/register', {
        data: { ...member, confirm_password: member.password },
      });
      expect(register.ok()).toBeTruthy();
      const memberId = (await login(request, member.email, member.password)).userId;

      expect(
        (await request.post('/api/admin/roles', { headers, data: { name: roleName } })).status(),
      ).toBe(201);
      const added = await request.post(`/api/admin/roles/${roleName}/members`, {
        headers,
        data: { userId: memberId },
      });
      expect(added.ok()).toBeTruthy();

      const deleted = await request.delete(`/api/admin/roles/${roleName}`, { headers });
      expect(deleted.ok()).toBeTruthy();

      const memberSession = await login(request, member.email, member.password);
      const self = await request.get('/api/user', { headers: memberSession.headers });
      expect(((await self.json()) as { role: string }).role).toBe('USER');

      const entries = await roleAudit(request, headers, roleName);
      const removed = entries.filter(
        (e) => e.action === 'role.member_removed' && e.metadata?.cause === 'role_deleted',
      );
      expect(removed).toHaveLength(1);
      expect(removed[0].metadata).toMatchObject({ userIds: memberId, count: 1, newRole: 'USER' });
      const outcome = entries.find((e) => e.action === 'role.deleted' && e.outcome === 'success');
      expect(outcome?.metadata).toMatchObject({ membersReassigned: 1 });
    } finally {
      await request.dispose();
      await cleanupUser(member);
    }
  });

  test('a role recreated under a deleted role name starts without its config profile @scenario:recreated-role-has-no-old-config', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const admin = getPrimaryE2EUser();
    const roleName = uniqueName('delete-config');
    const configPath = `/api/admin/config/role/${roleName}`;
    let headers: Record<string, string> = {};
    try {
      headers = (await login(request, admin.email, admin.password)).headers;

      expect(
        (await request.post('/api/admin/roles', { headers, data: { name: roleName } })).status(),
      ).toBe(201);
      const profile = await request.put(configPath, {
        headers,
        data: { priority: 10, overrides: { interface: { customWelcome: 'old role profile' } } },
      });
      expect(profile.ok()).toBeTruthy();
      expect((await request.get(configPath, { headers })).status()).toBe(200);

      expect((await request.delete(`/api/admin/roles/${roleName}`, { headers })).ok()).toBeTruthy();
      expect(
        (await request.post('/api/admin/roles', { headers, data: { name: roleName } })).status(),
      ).toBe(201);

      expect((await request.get(configPath, { headers })).status()).toBe(404);
    } finally {
      await request.delete(configPath, { headers });
      await request.delete(`/api/admin/roles/${roleName}`, { headers });
      await request.dispose();
    }
  });
});
