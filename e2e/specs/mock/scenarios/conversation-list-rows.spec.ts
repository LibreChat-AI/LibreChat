import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { loginAdmin, requestResult } from '../content-filters.helpers';
import { deleteConversations, withMongo } from '../db';

const SEEDED_MESSAGE_IDS = 2000;
const conversationIds: string[] = [];

test.afterEach(async () => {
  await deleteConversations(conversationIds.splice(0));
});

test.describe('conversation list rows', () => {
  test('conversation list rows carry metadata without the embedded message ids @scenario:conversation-list-rows-carry-no-message-ids', async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const conversationId = randomUUID();
    const title = `Heavy history ${conversationId.slice(0, 8)}`;
    conversationIds.push(conversationId);
    await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email: getE2EUser().email });
      if (!user) {
        throw new Error('E2E seed: user not found');
      }
      await db.collection('conversations').insertOne({
        conversationId,
        user: user._id.toString(),
        title,
        endpoint: 'Mock Provider A',
        model: 'mock-model-a',
        messages: Array.from({ length: SEEDED_MESSAGE_IDS }, () => new ObjectId()),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    const result = await requestResult(request, { path: '/api/convos?limit=25', token });
    expect(result.status).toBe(200);
    const body = result.body as { conversations: Array<Record<string, unknown>> };
    const row = body.conversations.find((convo) => convo.conversationId === conversationId);
    expect(row, 'the seeded conversation is listed').toBeDefined();
    expect(row?.title).toBe(title);
    expect(row?.model).toBe('mock-model-a');
    expect(row).not.toHaveProperty('messages');
  });
});
