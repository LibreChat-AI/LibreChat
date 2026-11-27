import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';

/** The footer `@librechat/chat`'s `MessageFooter` draws under a user prompt that has an edited
 *  sibling: aligned to the user's edge, with the sibling navigation at that edge after the
 *  actions. Seeded straight into Mongo so the prompt has two versions. */

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const userEmail = getE2EUser().email;
const createdConversationIds: string[] = [];

test.afterAll(async () => {
  await deleteMessagesByConversation(createdConversationIds);
  await deleteConversations(createdConversationIds);
});

test('an edited prompt keeps its footer at the user edge with the versions last @scenario:user-footer-keeps-edge-order', async ({
  page,
}, testInfo) => {
  const conversationId = randomUUID();
  const firstPrompt = randomUUID();
  const editedPrompt = randomUUID();
  await seedConversations(userEmail, [
    { conversationId, title: `Footer ${conversationId.slice(0, 8)}`, updatedAt: new Date() },
  ]);
  createdConversationIds.push(conversationId);
  await seedMessages(userEmail, conversationId, [
    {
      messageId: firstPrompt,
      parentMessageId: ROOT_PARENT,
      text: 'Summarize the release notes',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: firstPrompt,
      text: 'The release adds a theme engine.',
      isCreatedByUser: false,
      sender: 'OpenAI',
    },
    {
      messageId: editedPrompt,
      parentMessageId: ROOT_PARENT,
      text: 'Summarize the release notes in one line',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: editedPrompt,
      text: 'A theme engine, in one line.',
      isCreatedByUser: false,
      sender: 'OpenAI',
    },
  ]);

  await page.goto(`/c/${conversationId}`);
  const row = page.locator(`[id="${editedPrompt}"]`);
  await expect(row).toBeVisible();
  await row.hover();

  const versions = row.getByRole('navigation', { name: 'Sibling message navigation' });
  await expect(versions).toBeVisible();
  await expect(versions.getByRole('status')).toHaveText('2 / 2');
  await expect(versions).toHaveClass(/(^|\s)order-last(\s|$)/);
  await expect(versions.locator('..')).toHaveClass(/(^|\s)justify-end(\s|$)/);

  const versionsBox = await versions.boundingBox();
  const copyBox = await row.getByRole('button', { name: 'Copy to clipboard' }).boundingBox();
  expect(versionsBox && copyBox && versionsBox.x > copyBox.x).toBe(true);

  await testInfo.attach('user-footer', {
    body: await row.screenshot(),
    contentType: 'image/png',
  });
});
