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

const WAKEUP_PROMPT = [
  'A background tool task has finished. Continue using its durable result below.',
  JSON.stringify([
    {
      background_task_id: 'task-1',
      tool_call_id: 'call-1',
      tool: 'execute_code',
      status: 'completed',
      result: 'build finished',
    },
  ]),
].join('\n');

/** A host-authored wake-up turn and the reply it resumed, seeded straight into
 *  Mongo: the mock model cannot settle a background task. */
async function seedWakeup(text: string) {
  const conversationId = randomUUID();
  const wakeupId = randomUUID();
  const messages: SeedMessage[] = [
    {
      messageId: wakeupId,
      parentMessageId: ROOT_PARENT,
      text,
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: wakeupId,
      text: 'The build is done.',
      isCreatedByUser: false,
      sender: 'OpenAI',
    },
  ];
  await seedConversations(userEmail, [
    { conversationId, title: `Wakeup ${conversationId.slice(0, 8)}`, updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, messages);
  return conversationId;
}

async function cleanup(conversationId: string) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

test.describe('wake-up turns', () => {
  test('a background task wake-up renders as a task card, not its prompt @scenario:background-wakeup-renders-task-card', async ({
    page,
  }) => {
    const conversationId = await seedWakeup(WAKEUP_PROMPT);
    try {
      await page.goto(`/c/${conversationId}`);
      await expect(page.getByText('The build is done.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Background task finished' })).toBeVisible();
      await expect(page.getByText('"background_task_id"')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  test('a user turn quoting a wake-up prompt mid-message stays plain text @scenario:quoted-wakeup-prompt-stays-text', async ({
    page,
  }) => {
    const conversationId = await seedWakeup(`Why did I get this?\n${WAKEUP_PROMPT}`);
    try {
      await page.goto(`/c/${conversationId}`);
      await expect(page.getByText('Why did I get this?')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Background task finished' })).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });
});
