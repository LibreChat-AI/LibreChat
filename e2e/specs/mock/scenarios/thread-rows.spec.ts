import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  withMongo,
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { getE2EUser } from '../../../setup/user';
import { messagesView } from '../helpers';

/**
 * The thread rows the message list renders from `@librechat/chat`: the sibling switch of a
 * branched reply, the subagent activity group anchored after the reply to the request that
 * launched it, and the group stepping aside while that request is edited. The sibling switch runs
 * through both renderers.
 */

const ROOT = '00000000-0000-0000-0000-000000000000';

const messageRow = (page: Page, text: string): Locator =>
  messagesView(page).locator('.message-render').filter({ hasText: text }).last();

const siblingCounter = (row: Locator): Locator => row.locator('nav [role="status"]');

async function clickSibling(row: Locator, direction: 'Previous' | 'Next') {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole('button', { name: `${direction} sibling message` }).click();
}

/** A question with two replies, the newer one last. */
async function seedBranchedChat(label: string): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: `Branched ${label}`, updatedAt: new Date() },
  ]);
  const question = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: question,
      parentMessageId: ROOT,
      text: `Question ${label}`,
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: question,
      text: `Older reply ${label}`,
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
    {
      messageId: randomUUID(),
      parentMessageId: question,
      text: `Newer reply ${label}`,
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
  ]);
  return conversationId;
}

async function expectSiblingSwitch(page: Page, label: string) {
  const newer = messageRow(page, `Newer reply ${label}`);
  await expect(newer).toBeVisible({ timeout: 15_000 });
  await expect(siblingCounter(newer)).toHaveText('2 / 2');
  await expect(messagesView(page).getByText(`Older reply ${label}`)).toHaveCount(0);

  await clickSibling(newer, 'Previous');
  const older = messageRow(page, `Older reply ${label}`);
  await expect(older).toBeVisible();
  await expect(siblingCounter(older)).toHaveText('1 / 2');
  await expect(messagesView(page).getByText(`Newer reply ${label}`)).toHaveCount(0);
  await expect(older.getByRole('button', { name: 'Previous sibling message' })).toBeDisabled();

  await clickSibling(older, 'Next');
  await expect(messageRow(page, `Newer reply ${label}`)).toBeVisible();
  await expect(siblingCounter(messageRow(page, `Newer reply ${label}`))).toHaveText('2 / 2');
  await expect(messagesView(page).getByText(`Question ${label}`)).toBeVisible();
}

type ActivityChat = { conversationId: string; childConversationId: string };

/**
 * Two agent turns, with one event-bound child thread persisted against the FIRST request: the
 * shape an external event leaves behind, which the thread shows after that request's reply.
 */
async function seedActivityChat(label: string): Promise<ActivityChat> {
  const conversationId = randomUUID();
  const childConversationId = randomUUID();
  const firstRequest = randomUUID();
  const firstReply = randomUUID();
  const secondRequest = randomUUID();
  const { email } = getE2EUser();
  const turns = [
    { messageId: firstRequest, parentMessageId: ROOT, text: `First request ${label}`, user: true },
    {
      messageId: firstReply,
      parentMessageId: firstRequest,
      text: `First reply ${label}`,
      user: false,
    },
    {
      messageId: secondRequest,
      parentMessageId: firstReply,
      text: `Second request ${label}`,
      user: true,
    },
    {
      messageId: randomUUID(),
      parentMessageId: secondRequest,
      text: `Second reply ${label}`,
      user: false,
    },
  ];
  await withMongo(async (db) => {
    const owner = await db.collection('users').findOne({ email });
    if (!owner) {
      throw new Error(`E2E seed: user "${email}" not found`);
    }
    const user = owner._id.toString();
    const now = Date.now();
    await db.collection('conversations').insertMany([
      {
        conversationId,
        title: `Activity ${label}`,
        user,
        endpoint: 'agents',
        isArchived: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        __v: 0,
      },
      {
        conversationId: childConversationId,
        title: `Event child ${label}`,
        user,
        endpoint: 'agents',
        isArchived: false,
        subagentThread: {
          rootConversationId: conversationId,
          parentConversationId: conversationId,
          parentMessageId: firstRequest,
          parentToolCallId: `event-binding:${label}`,
          subagentType: 'e2e-event',
          subagentKind: 'agent',
          depth: 1,
        },
        agentEventBinding: {
          bindingId: `binding-${label}`,
          sourceKeyId: `source-${label}`,
          actorId: `actor-${label}`,
        },
        createdAt: new Date(now),
        updatedAt: new Date(now),
        __v: 0,
      },
    ]);
    await db.collection('messages').insertMany(
      turns.map((turn, index) => ({
        messageId: turn.messageId,
        parentMessageId: turn.parentMessageId,
        conversationId,
        text: turn.text,
        isCreatedByUser: turn.user,
        sender: turn.user ? 'User' : 'Mock Agent',
        user,
        endpoint: 'agents',
        error: false,
        unfinished: false,
        createdAt: new Date(now + index * 1000),
        updatedAt: new Date(now + index * 1000),
        __v: 0,
      })),
    );
  });
  return { conversationId, childConversationId };
}

const activityGroup = (page: Page): Locator =>
  messagesView(page).getByRole('region', { name: 'Agent activity' });

test.describe('thread rows', () => {
  let conversationIds: string[] = [];

  test.afterEach(async () => {
    if (conversationIds.length === 0) {
      return;
    }
    await deleteMessagesByConversation(conversationIds);
    await deleteConversations(conversationIds);
    conversationIds = [];
  });

  test('a branched reply switches siblings with both arrows and the counter @scenario:thread-sibling-switch', async ({
    page,
  }) => {
    const label = `siblings-${Date.now().toString(36)}`;
    const conversationId = await seedBranchedChat(label);
    conversationIds.push(conversationId);
    await page.goto(`/c/${conversationId}`, { timeout: 15_000 });
    await expectSiblingSwitch(page, label);
  });

  test('the recursive renderer switches siblings the same way @scenario:thread-sibling-switch-recursive', async ({
    page,
  }) => {
    const label = `siblings-tree-${Date.now().toString(36)}`;
    const conversationId = await seedBranchedChat(label);
    conversationIds.push(conversationId);
    await page.addInitScript(() => {
      localStorage.setItem('LC_FLAT_THREAD', 'false');
    });
    await page.goto(`/c/${conversationId}`, { timeout: 15_000 });
    await expectSiblingSwitch(page, label);
  });

  test('subagent activity sits after the reply to the request that launched it, ahead of the next turn @scenario:thread-activity-under-parent', async ({
    page,
  }) => {
    const label = `rows-anchor-${Date.now().toString(36)}`;
    const chat = await seedActivityChat(label);
    conversationIds.push(chat.conversationId, chat.childConversationId);
    await page.goto(`/c/${chat.conversationId}`, { timeout: 15_000 });
    await expect(activityGroup(page)).toHaveCount(1, { timeout: 15_000 });

    const order = await page.evaluate((labelText) => {
      const view = document.querySelector('[data-testid="messages-view"]');
      const group = view?.querySelector('section[data-event-subagent-group]');
      const rows = Array.from(view?.querySelectorAll('.message-render') ?? []);
      if (!group) {
        return null;
      }
      return rows.map((row) => ({
        text: ['First request', 'First reply', 'Second request', 'Second reply'].find((prefix) =>
          row.textContent?.includes(`${prefix} ${labelText}`),
        ),
        beforeGroup: Boolean(row.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING),
      }));
    }, label);
    expect(order).toEqual([
      { text: 'First request', beforeGroup: true },
      { text: 'First reply', beforeGroup: true },
      { text: 'Second request', beforeGroup: false },
      { text: 'Second reply', beforeGroup: false },
    ]);
  });

  test('editing the request hides its activity group and cancelling restores it @scenario:thread-edit-hides-activity', async ({
    page,
  }) => {
    const label = `rows-edit-${Date.now().toString(36)}`;
    const chat = await seedActivityChat(label);
    conversationIds.push(chat.conversationId, chat.childConversationId);
    await page.goto(`/c/${chat.conversationId}`, { timeout: 15_000 });
    await expect(activityGroup(page)).toBeVisible({ timeout: 15_000 });

    const request = messageRow(page, `First request ${label}`);
    await request.scrollIntoViewIfNeeded();
    await request.hover();
    await request.getByRole('button', { name: 'Edit', exact: true }).last().click();
    const editor = messagesView(page).getByRole('region', { name: 'Edit message' });
    await expect(editor).toBeVisible();
    await expect(activityGroup(page)).toHaveCount(0);

    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toHaveCount(0);
    await expect(activityGroup(page)).toBeVisible();
  });
});
