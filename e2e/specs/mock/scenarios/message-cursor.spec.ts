import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  withMongo,
} from '../db';
import { NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';

type Page = { messages: { messageId: string; _id?: string }[]; nextCursor: string | null };

async function seedTied(conversationId: string, count: number): Promise<string[]> {
  const at = new Date('2026-01-01T00:00:00.123Z');
  await seedConversations(getE2EUser().email, [{ conversationId, title: 'cursor', updatedAt: at }]);
  return withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: getE2EUser().email });
    const rows = Array.from({ length: count }, (_, index) => ({
      messageId: `cursor-${index}-${randomUUID()}`,
      conversationId,
      user: String(user?._id),
      text: `message ${index}`,
      sender: 'User',
      isCreatedByUser: false,
      createdAt: at,
      updatedAt: at,
      __v: 0,
    }));
    await db.collection('messages').insertMany(rows);
    return rows.map((row) => row.messageId);
  });
}

test.describe('message cursor and page size', () => {
  const conversationIds: string[] = [];
  test.afterEach(async () => {
    await deleteMessagesByConversation(conversationIds);
    await deleteConversations(conversationIds);
    conversationIds.length = 0;
  });

  test('@scenario:message-pages-share-timestamp-without-skips messages sharing one timestamp are all returned across pages', async ({
    page,
  }) => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    const seeded = await seedTied(conversationId, 7);
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let index = 0; index < 10; index++) {
      const query = new URLSearchParams({ conversationId, pageSize: '3' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const result: Page = await requestJson<Page>(page, {
        path: `/api/messages?${query.toString()}`,
        token,
      });
      expect(result.messages.every((message) => message._id === undefined)).toBe(true);
      seen.push(...result.messages.map((message) => message.messageId));
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(seeded));
  });

  test('@scenario:message-page-size-capped an oversized pageSize returns a bounded page', async ({
    page,
  }) => {
    const conversationId = randomUUID();
    conversationIds.push(conversationId);
    await seedTied(conversationId, 4);
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const result = await requestJson<Page>(page, {
      path: `/api/messages?conversationId=${conversationId}&pageSize=999999999`,
      token,
    });
    expect(result.messages).toHaveLength(4);
    expect(result.nextCursor).toBeNull();
  });
});
