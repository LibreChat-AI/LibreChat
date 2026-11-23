import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  managementTenantId,
  managementUserId,
  startManagementOidc,
} from '../../setup/agent-management';
import { withMongo } from './db';

const path = '/api/agents/v1/conversations';
const newest = new Date('2026-10-01T00:00:00.000Z');
const label = 'Disposable metadata fixture';
const legacyTag = ' legacy ';
const longTag = 'long-'.padEnd(300, 'x');

test('lists, filters, pages and reads the bound account’s conversation metadata', async ({
  request,
}) => {
  const oidc = await startManagementOidc();
  const headers = { Authorization: `Bearer ${oidc.token}` };
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const [first, second, legacy, undated, unrelated, otherTenant, child, temporary, expired] = ids;
  const otherTenantId = `${managementTenantId}-metadata`;
  try {
    await withMongo(async (db) => {
      await db.collection('users').insertOne({
        _id: new ObjectId(managementUserId),
        name: label,
        email: 'conversation-metadata@example.test',
        emailVerified: true,
        provider: 'local',
        role: 'ADMIN',
        tenantId: managementTenantId,
      });
      const base = {
        user: managementUserId,
        tenantId: managementTenantId,
        title: label,
        endpoint: 'openAI',
        model: 'fixture-model',
        tags: ['demo'],
        createdAt: newest,
      };
      await db.collection('conversations').insertMany([
        { ...base, conversationId: second, updatedAt: newest, isArchived: true },
        { ...base, conversationId: first, updatedAt: newest, agent_id: 'agent_123' },
        { ...base, conversationId: undated, updatedAt: null },
        { ...base, conversationId: legacy, tags: [legacyTag, longTag, ''] },
        { ...base, conversationId: unrelated, user: new ObjectId().toString(), updatedAt: newest },
        { ...base, conversationId: otherTenant, tenantId: otherTenantId, updatedAt: newest },
        {
          ...base,
          conversationId: child,
          updatedAt: newest,
          subagentThread: { parentConversationId: first },
        },
        { ...base, conversationId: temporary, updatedAt: newest, isTemporary: true },
        {
          ...base,
          conversationId: expired,
          updatedAt: newest,
          isTemporary: false,
          expiredAt: new Date(0),
        },
      ]);
    });
    const fetchPage = async (params?: Record<string, string>) => {
      const response = await request.get(path, { headers, params });
      expect(response.status()).toBe(200);
      return await response.json();
    };

    const page = await fetchPage({ limit: '1' });
    expect(page).toEqual({
      object: 'list',
      data: [
        {
          id: first,
          title: label,
          createdAt: newest.toISOString(),
          updatedAt: newest.toISOString(),
          endpoint: 'openAI',
          model: 'fixture-model',
          tags: ['demo'],
          isArchived: false,
          agent_id: 'agent_123',
        },
      ],
      first_id: first,
      last_id: first,
      has_more: true,
      after: expect.any(String),
    });
    const next = await fetchPage({ limit: '1', cursor: page.after });
    expect(next).toMatchObject({ data: [{ id: second }], has_more: true });
    const tail = await fetchPage({ limit: '1', cursor: next.after });
    expect(tail).toMatchObject({ data: [{ id: legacy, updatedAt: null }], has_more: true });
    const end = await fetchPage({ limit: '1', cursor: tail.after });
    expect(end).toMatchObject({
      data: [{ id: undated, updatedAt: null }],
      has_more: false,
      after: null,
    });

    const archive = await fetchPage({ isArchived: 'true', tags: 'demo' });
    expect(archive.data).toMatchObject([{ id: second }]);
    const agent = await fetchPage({ agent_id: 'agent_123' });
    expect(agent.data).toMatchObject([{ id: first }]);
    const tagged = await fetchPage({ tags: legacyTag });
    expect(tagged.data).toMatchObject([{ id: legacy, tags: [legacyTag, longTag, ''] }]);
    for (const tag of [longTag, '']) {
      const matching = await fetchPage({ tags: tag });
      expect(matching.data.map((conversation: { id: string }) => conversation.id)).toEqual([
        legacy,
      ]);
    }

    const mismatch = await request.get(path, {
      headers,
      params: { cursor: page.after, tags: 'demo' },
    });
    expect(mismatch.status()).toBe(400);

    const detail = await request.get(`${path}/${first}`, { headers });
    expect(detail.status()).toBe(200);
    expect(await detail.json()).toEqual(page.data[0]);
    const missing = await request.get(`${path}/${randomUUID()}`, { headers });
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'not_found', message: 'Conversation not found' },
    });
  } finally {
    try {
      await withMongo(async (db) => {
        await db.collection('conversations').deleteMany({
          tenantId: { $in: [managementTenantId, otherTenantId] },
          conversationId: { $in: ids },
        });
        await db
          .collection('users')
          .deleteOne({ _id: new ObjectId(managementUserId), tenantId: managementTenantId });
      });
    } finally {
      await oidc.close();
    }
  }
});
