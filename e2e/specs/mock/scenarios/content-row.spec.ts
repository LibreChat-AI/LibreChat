import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SeedMessage } from '../db';
import { getE2EUser } from '../../../setup/user';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';

/** A structured reply's row, now drawn by `@librechat/chat`'s `ContentRow`: its header and
 *  actions, an error part named after the row's model, and the outcome notice under it. Seeded
 *  straight into Mongo, since the mock model cannot persist these part shapes. */

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const userEmail = getE2EUser().email;
const createdConversationIds: string[] = [];

test.describe.configure({ timeout: 120_000 });

test.afterAll(async () => {
  await deleteMessagesByConversation(createdConversationIds);
  await deleteConversations(createdConversationIds);
});

async function seedReply(reply: Omit<SeedMessage, 'messageId' | 'parentMessageId'>) {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const replyId = randomUUID();
  await seedConversations(userEmail, [
    { conversationId, title: `Content row ${conversationId.slice(0, 8)}`, updatedAt: new Date() },
  ]);
  createdConversationIds.push(conversationId);
  await seedMessages(userEmail, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: ROOT_PARENT,
      text: 'Check the deployment',
      isCreatedByUser: true,
      sender: 'User',
    },
    { messageId: replyId, parentMessageId: userMessageId, ...reply },
  ]);
  return { conversationId, replyId };
}

async function openReply(page: Page, conversationId: string, replyId: string) {
  await page.goto(`/c/${conversationId}`);
  const row = page.locator(`[id="${replyId}"]`);
  await expect(row).toBeVisible();
  await row.hover();
  return row;
}

test.describe('structured reply row', () => {
  test('a structured reply shows its author, its parts and its actions @scenario:content-row-structured-reply', async ({
    page,
  }) => {
    const { conversationId, replyId } = await seedReply({
      text: 'The deployment is healthy.',
      isCreatedByUser: false,
      sender: 'Ops Agent',
      content: [{ type: 'text', text: 'The deployment is healthy.' }],
    });

    const row = await openReply(page, conversationId, replyId);
    await expect(row).toHaveAccessibleName('Message 2');
    await expect(row.getByRole('heading', { level: 2 })).toContainText('Ops Agent');
    await expect(row.getByText('The deployment is healthy.')).toBeVisible();
    await expect(row.getByTestId('copy-response-button')).toBeVisible();
  });

  test('an error part names the model of the row that failed @scenario:content-row-error-names-row-model', async ({
    page,
  }) => {
    const { conversationId, replyId } = await seedReply({
      text: '',
      isCreatedByUser: false,
      sender: 'OpenAI',
      model: 'gpt-4o',
      content: [
        {
          type: 'error',
          error: JSON.stringify({ type: 'refusal', info: "I can't help with that request." }),
        },
      ],
    });

    const row = await openReply(page, conversationId, replyId);
    await expect(
      row.getByText('gpt-4o declined to answer this request. Rewrite your message and try again.'),
    ).toBeVisible();
  });

  test('a turn that ran out of agent steps shows the limit notice after its content @scenario:content-row-tool-call-limit-notice', async ({
    page,
  }) => {
    const { conversationId, replyId } = await seedReply({
      text: 'Checked three of five services.',
      isCreatedByUser: false,
      sender: 'OpenAI',
      unfinished: true,
      finish_reason: 'tool_call_limit',
      content: [{ type: 'text', text: 'Checked three of five services.' }],
    });

    const row = await openReply(page, conversationId, replyId);
    const notice = row.getByRole('group', { name: 'Reached the tool call limit for this turn' });
    await expect(notice).toBeVisible();
    await expect(row.getByRole('button', { name: 'Keep going' })).toBeVisible();

    await row.getByRole('button', { name: 'Dismiss this notice' }).click();
    await expect(notice).toHaveCount(0);
    await expect(row.getByText('Checked three of five services.')).toBeVisible();
  });
});
