import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import type { SeedMessage } from '../db';

const userEmail = getE2EUser().email;
const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';

/** A reply the user steered mid-stream, seeded straight into Mongo: the steer
 *  part sits between the text before and after it, as a finished run stores it. */
async function seedSteeredReply() {
  const conversationId = randomUUID();
  const userId = randomUUID();
  const replyId = randomUUID();
  const messages: SeedMessage[] = [
    {
      messageId: userId,
      parentMessageId: ROOT_PARENT,
      text: 'Tell me about animals',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: replyId,
      parentMessageId: userId,
      text: 'Dogs are loyal. Cats are independent.',
      isCreatedByUser: false,
      sender: 'OpenAI',
      content: [
        { type: 'text', text: 'Dogs are loyal.' },
        { type: 'steer', steer: 'Focus on cats', steerId: randomUUID() },
        { type: 'text', text: 'Cats are independent.' },
      ],
    },
  ];
  await seedConversations(userEmail, [
    { conversationId, title: `Steer ${conversationId.slice(0, 8)}`, updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, messages);
  return { conversationId, replyId };
}

async function cleanup(conversationId: string) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

test('content that resumes after a steer restates its author @scenario:steered-reply-restates-author-after-steer', async ({
  page,
}) => {
  const { conversationId, replyId } = await seedSteeredReply();
  try {
    await page.goto(`/c/${conversationId}`);
    const reply = page.locator(`[id="${replyId}"]`);
    await expect(reply.getByText('Focus on cats')).toBeVisible();
    await expect(reply.getByText('Cats are independent.')).toBeVisible();
    const header = reply.getByTestId('author-header');
    await expect(header).toHaveCount(1);
    await expect(header.getByRole('heading')).not.toHaveText('');
  } finally {
    await cleanup(conversationId);
  }
});
