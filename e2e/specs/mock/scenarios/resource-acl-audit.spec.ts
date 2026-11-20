import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken, requestJson } from '../helpers';
import { withMongo } from '../db';

/**
 * Sharing a resource writes one `acl.*` audit entry per effective grant and
 * revoke. The entries name the principal by id and carry permission bits only;
 * display names and emails of the people involved never reach the log.
 */

const RESOURCE_TYPE = 'promptGroup';
const VIEWER_ROLE = 'promptGroup_viewer';

type CreatedGroup = { group?: { _id: string; name: string } };
type AuditRow = { action: string; target?: { id?: string }; metadata?: Record<string, unknown> };

async function createGroup(page: Page, name: string): Promise<string> {
  const token = await getAccessToken(page);
  const body = await requestJson<CreatedGroup>(page, {
    path: '/api/prompts',
    token,
    method: 'POST',
    body: { prompt: { prompt: `Text for ${name}`, type: 'text' }, group: { name } },
  });
  const id = body.group?._id ?? '';
  expect(id).not.toBe('');
  return id;
}

async function seedUser(suffix: string) {
  const user = {
    _id: new ObjectId(),
    email: `acl-audit-${suffix}@example.com`,
    name: `Acl Audit ${suffix}`,
  };
  await withMongo((db) => db.collection('users').insertOne(user));
  return user;
}

const auditRows = (groupId: string, prefix: string) =>
  withMongo((db) =>
    db
      .collection('auditlogs')
      .find({ 'target.id': groupId, action: { $regex: `^${prefix}` } })
      .sort({ seq: 1 })
      .toArray(),
  ) as Promise<AuditRow[]>;

async function share(page: Page, groupId: string, body: unknown) {
  const token = await getAccessToken(page);
  await requestJson<unknown>(page, {
    path: `/api/permissions/${RESOURCE_TYPE}/${groupId}`,
    token,
    method: 'PUT',
    body,
  });
}

test.describe('resource ACL audit', () => {
  test('sharing then unsharing a prompt group records a grant and a revoke by principal id @scenario:sharing-a-resource-records-acl-grant-and-revoke-by-principal-id', async ({
    page,
  }) => {
    await page.goto('/c/new');
    const suffix = randomUUID().slice(0, 8);
    const groupId = await createGroup(page, `Acl audit ${suffix}`);
    const target = await seedUser(suffix);
    const principal = {
      type: 'user',
      id: target._id.toString(),
      name: target.name,
      email: target.email,
      source: 'local',
    };

    try {
      await share(page, groupId, {
        updated: [{ ...principal, accessRoleId: VIEWER_ROLE }],
        removed: [],
      });
      await expect
        .poll(async () => (await auditRows(groupId, 'acl.')).map((row) => row.action))
        .toEqual(['acl.granted']);

      await share(page, groupId, { updated: [], removed: [principal] });
      await expect
        .poll(async () => (await auditRows(groupId, 'acl.')).map((row) => row.action))
        .toEqual(['acl.granted', 'acl.revoked']);

      const rows = await auditRows(groupId, 'acl.');
      expect(rows[0].metadata).toEqual(
        expect.objectContaining({ principalType: 'user', principalId: principal.id }),
      );
      expect(rows[1].metadata).toEqual(
        expect.objectContaining({ principalType: 'user', principalId: principal.id }),
      );
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(target.name);
      expect(serialized).not.toContain(target.email);
    } finally {
      await withMongo((db) => db.collection('users').deleteOne({ _id: target._id }));
    }
  });

  test('re-sharing with the same role writes no new audit entry @scenario:resharing-with-an-unchanged-role-records-no-acl-entry', async ({
    page,
  }) => {
    await page.goto('/c/new');
    const suffix = randomUUID().slice(0, 8);
    const groupId = await createGroup(page, `Acl noop ${suffix}`);
    const target = await seedUser(suffix);
    const body = {
      updated: [
        {
          type: 'user',
          id: target._id.toString(),
          name: target.name,
          email: target.email,
          source: 'local',
          accessRoleId: VIEWER_ROLE,
        },
      ],
      removed: [],
    };

    try {
      await share(page, groupId, body);
      await expect.poll(async () => (await auditRows(groupId, 'acl.')).length).toBe(1);
      await share(page, groupId, body);
      expect(await auditRows(groupId, 'acl.')).toHaveLength(1);
    } finally {
      await withMongo((db) => db.collection('users').deleteOne({ _id: target._id }));
    }
  });
});
