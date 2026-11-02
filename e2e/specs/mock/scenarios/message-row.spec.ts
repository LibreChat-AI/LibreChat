import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  withMongo,
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { getAccessToken, requestJson } from '../helpers';
import { getE2EUser } from '../../../setup/user';

/** Rows built from the package's MessageRow and MessageTimestamp, with the attachments the app
 *  host renders into them, on the chat route and on a public shared link. */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const TEXT = 'Rows keep their header, timestamp and attachments.';

async function seedThread(email: string, createdAt: Date) {
  const conversationId = randomUUID();
  const userId = randomUUID();
  const replyId = randomUUID();
  await seedConversations(email, [
    { conversationId, title: 'Message row fixture', updatedAt: new Date() },
  ]);
  await seedMessages(email, conversationId, [
    {
      messageId: userId,
      parentMessageId: NO_PARENT,
      text: TEXT,
      isCreatedByUser: true,
      sender: 'User',
      files: [{ file_id: randomUUID(), filename: 'row-notes.txt', type: 'text/plain', bytes: 64 }],
    },
    {
      messageId: replyId,
      parentMessageId: userId,
      text: `Reply to ${TEXT}`,
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  await withMongo((db) =>
    db.collection('messages').updateMany({ conversationId }, { $set: { createdAt } }),
  );
  return { conversationId, userId, replyId };
}

const row = (page: Page, id: string) => page.locator(`[id="${id}"]`);

test.describe('message row', () => {
  test('a recent message is stamped with its relative time and exact date @scenario:message-row-shows-relative-timestamp', async ({
    page,
  }) => {
    const { email } = getE2EUser();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { conversationId, replyId } = await seedThread(email, twoHoursAgo);
    try {
      await page.goto(`/c/${conversationId}`);
      const reply = row(page, replyId);
      await expect(reply).toContainText(`Reply to ${TEXT}`);
      const time = reply.locator('time').first();
      await expect(time).toHaveAttribute('datetime', twoHoursAgo.toISOString());
      await expect(time).toHaveText('2 hours ago');
      await expect(time).toHaveAttribute('title', /\d/);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a shared link shows the attachments of a user message @scenario:shared-row-shows-user-attachments', async ({
    page,
  }) => {
    const { email } = getE2EUser();
    const { conversationId, userId } = await seedThread(email, new Date());
    try {
      await page.goto(`/c/${conversationId}`);
      await expect(
        row(page, userId).getByTestId('message-attachments').getByRole('button'),
      ).toHaveCount(1);

      const token = await getAccessToken(page);
      const share = await requestJson<{ shareId?: string }>(page, {
        path: `/api/share/${conversationId}`,
        token,
        method: 'POST',
        body: {},
      });
      if (!share.shareId) {
        throw new Error('Expected the share response to include a shareId');
      }
      await page.goto(`/share/${share.shareId}`);
      const shared = page.locator('.message-render').filter({ hasText: TEXT }).first();
      await expect(shared).toBeVisible({ timeout: 15000 });
      await expect(shared.getByTestId('message-attachments')).toBeVisible();
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
