import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { loginAdmin, requestResult } from '../content-filters.helpers';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  mockReply,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * `retentionMode: "ephemeral"` is administrator state, so every scenario sets it as a
 * stored config override for the signed-in user and clears it afterwards. The default
 * mode is exercised by leaving the override off, which is what proves the feature is
 * opt-in rather than a change to how LibreChat saves chats today.
 */

const userEmail = getE2EUser().email;
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const cleanupConversationIds: string[] = [];

type StoredConversation = {
  conversationId: string;
  isTemporary?: boolean;
  expiredAt?: Date | null;
};

type StoredMessage = StoredConversation & { messageId: string };

async function resolveUserId(): Promise<string> {
  return withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) {
      throw new Error(`E2E seed: user "${userEmail}" not found`);
    }
    return user._id.toString();
  });
}

async function setRetentionMode(
  request: APIRequestContext,
  token: string,
  userId: string,
): Promise<void> {
  const result = await requestResult(request, {
    path: `/api/admin/config/user/${encodeURIComponent(userId)}`,
    token,
    method: 'PUT',
    data: {
      overrides: { interface: { retentionMode: 'ephemeral', temporaryChatRetention: 1 } },
      priority: 50,
    },
  });
  expect(result.ok, `Expected the retention override to be stored: ${result.text}`).toBe(true);
}

async function clearRetentionMode(
  request: APIRequestContext,
  token: string,
  userId: string,
): Promise<void> {
  await requestResult(request, {
    path: `/api/admin/config/user/${encodeURIComponent(userId)}`,
    token,
    method: 'DELETE',
  });
}

async function seedPermanentConversation(
  userId: string,
  messages: Record<string, unknown>[],
  conversationFields: Record<string, unknown> = {},
): Promise<string> {
  const conversationId = randomUUID();
  cleanupConversationIds.push(conversationId);
  await withMongo(async (db) => {
    const now = new Date();
    await db.collection('conversations').insertOne({
      conversationId,
      title: 'Permanent chat',
      user: userId,
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      isArchived: false,
      isTemporary: false,
      createdAt: now,
      updatedAt: now,
      __v: 0,
      ...conversationFields,
    });
    await db.collection('messages').insertMany(
      messages.map((message, index) => ({
        conversationId,
        user: userId,
        endpoint: 'Mock Provider A',
        model: 'mock-model-a',
        error: false,
        unfinished: false,
        isTemporary: false,
        createdAt: new Date(now.getTime() + index * 1000),
        updatedAt: new Date(now.getTime() + index * 1000),
        __v: 0,
        ...message,
      })),
    );
  });
  return conversationId;
}

async function readConversation(conversationId: string): Promise<StoredConversation | null> {
  return withMongo(
    async (db) =>
      (await db
        .collection('conversations')
        .findOne({ conversationId })) as StoredConversation | null,
  );
}

async function readMessages(conversationId: string): Promise<StoredMessage[]> {
  return withMongo(
    async (db) =>
      (await db
        .collection('messages')
        .find({ conversationId })
        .toArray()) as unknown as StoredMessage[],
  );
}

function expectForcedTemporary(row: StoredConversation | StoredMessage | null): void {
  expect(row, 'Expected the row to still exist').not.toBeNull();
  expect(row?.isTemporary).toBe(true);
  expect(row?.expiredAt).toBeInstanceOf(Date);
}

async function startMockChat(page: Page): Promise<void> {
  await page.goto(NEW_CHAT_PATH);
  await mockReply(page);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

test.afterEach(async () => {
  const conversationIds = cleanupConversationIds.splice(0);
  if (conversationIds.length === 0) {
    return;
  }
  await deleteMessagesByConversation(conversationIds);
  await deleteConversations(conversationIds);
});

test.describe('ephemeral retention', () => {
  let token: string;
  let userId: string;

  test.beforeEach(async ({ request }) => {
    token = await loginAdmin(request);
    userId = await resolveUserId();
  });

  test.afterEach(async ({ request }) => {
    await clearRetentionMode(request, token, userId);
  });

  test('a new chat is saved temporary and stays out of history @scenario:a-new-chat-is-saved-temporary-under-ephemeral-retention', async ({
    page,
    request,
  }) => {
    await setRetentionMode(request, token, userId);
    await startMockChat(page);

    const response = await sendMessageAndWaitForCompletion(page, 'Forced temporary turn');
    const conversationId = ((await response.json()) as { conversationId?: string }).conversationId;
    expect(conversationId, 'the turn must identify its conversation').toBeTruthy();
    cleanupConversationIds.push(conversationId as string);

    expectForcedTemporary(await readConversation(conversationId as string));
    const messages = await readMessages(conversationId as string);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expectForcedTemporary(message);
    }

    const history = await requestResult(request, { path: '/api/convos?limit=25', token });
    expect(history.text).not.toContain(conversationId as string);
  });

  test('the temporary toggle is locked on @scenario:the-temporary-toggle-is-locked-on-under-ephemeral-retention', async ({
    page,
    request,
  }) => {
    await setRetentionMode(request, token, userId);
    await startMockChat(page);

    /** The header collapses its secondary actions into the overflow menu below `md`,
     *  so the enforced control a narrow viewport offers is the menu's checkbox item
     *  while a wide one offers the toggle. Both carry the same locked contract. */
    if ((page.viewportSize()?.width ?? 0) < 768) {
      await page.locator('#header-menu-button').click();
      const item = page.getByRole('menuitemcheckbox', { name: /administrator/i });
      await expect(item).toHaveAttribute('aria-checked', 'true');
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await item.click({ force: true });
      await expect(item).toHaveAttribute('aria-checked', 'true');
      return;
    }

    const toggle = page.getByRole('button', { name: /administrator/i });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');

    /** aria-disabled keeps the control focusable and announced, which also makes
     *  Playwright treat it as not actionable, so the click has to be forced to
     *  prove the handler refuses it rather than that the element is unreachable. */
    await toggle.focus();
    await expect(toggle, 'an enforced control stays reachable by keyboard').toBeFocused();

    await toggle.click({ force: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('editing a message converts the chat holding it @scenario:editing-a-message-converts-its-pre-existing-chat', async ({
    request,
  }) => {
    const messageId = randomUUID();
    const conversationId = await seedPermanentConversation(userId, [
      {
        messageId,
        parentMessageId: NO_PARENT,
        isCreatedByUser: true,
        text: 'Original question',
      },
    ]);

    await setRetentionMode(request, token, userId);
    const edit = await requestResult(request, {
      path: `/api/messages/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}`,
      token,
      method: 'PUT',
      data: { text: 'Edited question', model: 'mock-model-a' },
    });
    expect(edit.ok, `Expected the edit to succeed: ${edit.text}`).toBe(true);

    expectForcedTemporary(await readConversation(conversationId));
    const [message] = await readMessages(conversationId);
    expectForcedTemporary(message);
  });

  test('branching a response converts the chat holding it @scenario:branching-a-response-converts-its-pre-existing-chat', async ({
    request,
  }) => {
    const messageId = randomUUID();
    const agentId = 'agent-mock-a';
    const conversationId = await seedPermanentConversation(userId, [
      {
        messageId,
        parentMessageId: NO_PARENT,
        isCreatedByUser: false,
        text: 'Parallel answer',
        content: [
          { type: 'text', text: 'First agent answer', agentId },
          { type: 'text', text: 'Second agent answer', agentId: 'agent-mock-b' },
        ],
      },
    ]);

    await setRetentionMode(request, token, userId);
    const branch = await requestResult(request, {
      path: '/api/messages/branch',
      token,
      method: 'POST',
      data: { messageId, agentId },
    });
    expect(branch.ok, `Expected the branch to be created: ${branch.text}`).toBe(true);

    expectForcedTemporary(await readConversation(conversationId));
  });

  test('a duplicated chat is temporary and adds no bookmark counts @scenario:a-duplicated-chat-is-forced-temporary-without-bookmark-counts', async ({
    request,
  }) => {
    const tag = `retention-${randomUUID().slice(0, 8)}`;
    const conversationId = await seedPermanentConversation(
      userId,
      [
        {
          messageId: randomUUID(),
          parentMessageId: NO_PARENT,
          isCreatedByUser: true,
          text: 'Bookmarked question',
        },
      ],
      { tags: [tag] },
    );
    await withMongo(async (db) => {
      await db
        .collection('conversationtags')
        .insertOne({ user: userId, tag, count: 1, position: 0, __v: 0 });
    });

    await setRetentionMode(request, token, userId);
    const duplicate = await requestResult(request, {
      path: '/api/convos/duplicate',
      token,
      method: 'POST',
      data: { conversationId, title: 'Duplicated chat' },
    });
    expect(duplicate.ok, `Expected the duplicate to succeed: ${duplicate.text}`).toBe(true);
    const duplicatedId = (duplicate.body as { conversation?: { conversationId?: string } })
      ?.conversation?.conversationId;
    expect(duplicatedId, 'the duplicate must identify its conversation').toBeTruthy();
    cleanupConversationIds.push(duplicatedId as string);

    expectForcedTemporary(await readConversation(duplicatedId as string));

    const tagRow = await withMongo(async (db) =>
      db.collection('conversationtags').findOne({ user: userId, tag }),
    );
    expect(tagRow?.count, 'a hidden chat must not raise its bookmark count').toBe(1);

    await withMongo(async (db) => {
      await db.collection('conversationtags').deleteOne({ user: userId, tag });
    });
  });

  test('chats stay permanent under the default retention mode @scenario:chats-stay-permanent-under-the-default-retention-mode', async ({
    page,
    request,
  }) => {
    await startMockChat(page);

    const response = await sendMessageAndWaitForCompletion(page, 'Ordinary saved turn');
    const conversationId = ((await response.json()) as { conversationId?: string }).conversationId;
    expect(conversationId, 'the turn must identify its conversation').toBeTruthy();
    cleanupConversationIds.push(conversationId as string);

    const conversation = await readConversation(conversationId as string);
    expect(conversation?.isTemporary ?? false).toBe(false);
    expect(conversation?.expiredAt ?? null).toBeNull();

    const history = await requestResult(request, { path: '/api/convos?limit=25', token });
    expect(history.text).toContain(conversationId as string);
  });
});
