import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/**
 * A field write that finds the document already as requested writes nothing: a retried PATCH,
 * DELETE or tombstone answers 200 with the stored config, keeps its revision and leaves no
 * second audit entry, and a PATCH that changes some of its paths records only those. The
 * primary user (first registered, ADMIN) writes overrides for a user this file registers and
 * reads the audit log back filtered by that user's id.
 */

type Session = { headers: Record<string, string>; userId: string };
type AuditEntry = {
  action: string;
  target?: { id?: string };
  metadata?: Record<string, unknown>;
};
type WrittenConfig = { config?: { revision?: string; overrides?: Record<string, unknown> } };

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
  email: `config-noop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: 'Config No-op Target',
  password: 'securepassword789',
};

let cached: { admin: Session; target: Session } | undefined;

/** Logs in once per worker: the harness allows 20 logins per window across all specs. */
async function sessions(request: APIRequestContext): Promise<{ admin: Session; target: Session }> {
  if (!cached) {
    cached = {
      admin: await login(request, getPrimaryE2EUser()),
      target: await login(request, targetUser),
    };
  }
  return cached;
}

const configPath = (userId: string) => `/api/admin/config/user/${userId}`;

async function clearOverrides(
  request: APIRequestContext,
  admin: Session,
  userId: string,
): Promise<void> {
  const res = await request.delete(configPath(userId), { headers: admin.headers });
  expect([200, 204, 404]).toContain(res.status());
}

/** The revision the response's config carries. */
async function revisionOf(res: { json: () => Promise<unknown> }): Promise<string | undefined> {
  return ((await res.json()) as WrittenConfig).config?.revision;
}

/** The config write entries the audit log holds for `userId`, newest first. */
async function configAudits(
  request: APIRequestContext,
  admin: Session,
  userId: string,
  operation: string,
): Promise<AuditEntry[]> {
  const res = await request.get('/api/admin/audit-log', {
    headers: admin.headers,
    params: { search: userId, limit: 100 },
  });
  expect(res.ok()).toBeTruthy();
  const { entries } = (await res.json()) as { entries: AuditEntry[] };
  return entries.filter(
    (entry) =>
      entry.action.startsWith('config.') &&
      entry.target?.id?.includes(userId) &&
      entry.metadata?.operation === operation,
  );
}

test.describe('Config field writes that change nothing', () => {
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

  test('a retried field patch keeps the revision and records one audit entry @scenario:config-patch-retry-writes-nothing', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      const entries = [{ fieldPath: 'interface.customWelcome', value: 'retried' }];
      const first = await request.patch(`${configPath(target.userId)}/fields`, {
        headers: admin.headers,
        data: { entries },
      });
      expect(first.status()).toBe(200);
      const written = await revisionOf(first);
      expect(written).toBeTruthy();

      const retry = await request.patch(`${configPath(target.userId)}/fields`, {
        headers: admin.headers,
        data: { entries },
      });
      expect(retry.status()).toBe(200);
      expect(await revisionOf(retry)).toBe(written);

      const audits = await configAudits(request, admin, target.userId, 'patch');
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata?.fieldPaths).toBe('interface.customWelcome');
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });

  test('a field patch that changes one of two paths audits only that path @scenario:config-patch-audits-only-changed-paths', async ({
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
      const before = await configAudits(request, admin, target.userId, 'patch');

      const mixed = await request.patch(`${configPath(target.userId)}/fields`, {
        headers: admin.headers,
        data: {
          entries: [
            { fieldPath: 'interface.customWelcome', value: 'kept' },
            { fieldPath: 'interface.contextCost', value: false },
          ],
        },
      });
      expect(mixed.status()).toBe(200);

      const audits = await configAudits(request, admin, target.userId, 'patch');
      expect(audits).toHaveLength(before.length + 1);
      expect(audits[0]).toMatchObject({
        action: 'config.updated',
        metadata: { operation: 'patch', fieldPaths: 'interface.contextCost' },
      });
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });

  test('a retried field delete, or one of a path never stored, keeps the revision @scenario:config-field-delete-retry-writes-nothing', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      const seeded = await request.put(configPath(target.userId), {
        headers: admin.headers,
        data: { overrides: { interface: { customWelcome: 'removed', contextCost: false } } },
      });
      expect(seeded.ok()).toBeTruthy();
      const fields = `${configPath(target.userId)}/fields`;

      const removed = await request.delete(fields, {
        headers: admin.headers,
        params: { fieldPath: 'interface.customWelcome' },
      });
      expect(removed.status()).toBe(200);
      const written = await revisionOf(removed);
      expect(written).toBeTruthy();

      for (const fieldPath of ['interface.customWelcome', 'interface.modelSelect']) {
        const retry = await request.delete(fields, {
          headers: admin.headers,
          params: { fieldPath },
        });
        expect(retry.status()).toBe(200);
        expect(await revisionOf(retry)).toBe(written);
      }

      const audits = await configAudits(request, admin, target.userId, 'unset');
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata?.fieldPath).toBe('interface.customWelcome');
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });

  test('a retried tombstone keeps the revision and records one audit entry @scenario:config-tombstone-retry-writes-nothing', async ({
    request,
  }) => {
    const { admin, target } = await sessions(request);
    await clearOverrides(request, admin, target.userId);
    try {
      const tombstone = () =>
        request.post(`${configPath(target.userId)}/fields/tombstone`, {
          headers: admin.headers,
          data: { fieldPath: 'memory.agent' },
        });
      const first = await tombstone();
      expect(first.status()).toBe(200);
      const written = await revisionOf(first);
      expect(written).toBeTruthy();

      const retry = await tombstone();
      expect(retry.status()).toBe(200);
      expect(await revisionOf(retry)).toBe(written);

      const audits = await configAudits(request, admin, target.userId, 'tombstone');
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata?.fieldPath).toBe('memory.agent');
    } finally {
      await clearOverrides(request, admin, target.userId);
    }
  });
});
