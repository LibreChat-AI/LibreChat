import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedMessages, withMongo } from '../db';
import { messagesView, sendMessage, sendMessageAndWaitForCompletion } from '../helpers';

const userEmail = getE2EUser().email;
const LABEL_SERVER = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;

type Row = Record<string, unknown>;

async function cleanup(conversationId: string) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

function findRow(filter: Row): Promise<Row | null> {
  return withMongo((db) => db.collection('messages').findOne(filter));
}

/** A finished exchange plus a user leaf seeded under its answer, then a manual
 *  compaction held open on that leaf until the caller presses Stop. */
async function startCompactionOnUserLeaf(page: Page, request: APIRequestContext, label: string) {
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, `tell me about ${label}`);
  const conversationId = new URL(page.url()).pathname.replace('/c/', '');
  expect(conversationId).not.toBe('new');

  const answer = await withMongo((db) =>
    db
      .collection('messages')
      .findOne({ conversationId, isCreatedByUser: false }, { sort: { createdAt: -1 } }),
  );
  expect(answer?.messageId).toBeTruthy();

  const leafUserId = randomUUID();
  const leafText = `Compact this before answering ${label}`;
  await seedMessages(userEmail, conversationId, [
    {
      messageId: leafUserId,
      parentMessageId: answer?.messageId as string,
      text: leafText,
      isCreatedByUser: true,
      sender: 'User',
    },
  ]);

  const behavior = await request.post(`${LABEL_SERVER}/__e2e/behavior`, {
    data: { mode: 'ok', delayMs: 60_000 },
  });
  expect(behavior.ok()).toBeTruthy();

  await page.goto(`/c/${conversationId}`);
  await expect(messagesView(page).getByText(leafText)).toBeVisible();
  await page.getByTestId('token-usage').click();
  await page.getByRole('button', { name: 'Compact context' }).click();
  const stop = page.getByTestId('stop-generation-button');
  await expect(stop).toBeVisible({ timeout: 20_000 });
  return { conversationId, leafUserId, leafText, stop };
}

test.describe('compaction abort finalize', () => {
  test.afterEach(async ({ request }) => {
    const response = await request.post(`${LABEL_SERVER}/__e2e/reset`);
    expect(response.ok()).toBeTruthy();
  });

  /* The stopped compaction's anchor is the persisted leaf itself: the abort
     writes a settled response under it and leaves the leaf exactly as it was. */
  test('a stopped compaction settles under its anchor and survives a reload @scenario:stopped-compaction-settles-under-its-anchor', async ({
    page,
    request,
  }) => {
    const { conversationId, leafUserId, leafText, stop } = await startCompactionOnUserLeaf(
      page,
      request,
      'stopped-anchor',
    );
    try {
      await stop.click();

      let compaction: Row | null = null;
      await expect
        .poll(
          async () => {
            compaction = await findRow({
              conversationId,
              parentMessageId: leafUserId,
              isCreatedByUser: false,
            });
            return compaction != null;
          },
          { timeout: 20_000 },
        )
        .toBeTruthy();
      const compactionId = (compaction as Row | null)?.messageId as string;
      await expect(stop).toBeHidden({ timeout: 20_000 });

      /* A live snapshot's shape would leave the turn reading as still running. */
      const settled = await findRow({ conversationId, messageId: compactionId });
      expect(settled?.unfinished).not.toBe(true);

      const leaf = await findRow({ conversationId, messageId: leafUserId });
      expect(leaf?.isCreatedByUser).toBe(true);
      expect(leaf?.text).toBe(leafText);

      await page.reload();
      const row = page.locator(`[id="${compactionId}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.getByText('Could not compact the context', { exact: false })).toBeVisible();
      await expect(row.getByText('Summarizing...')).toHaveCount(0);
      await expect(messagesView(page).getByText(leafText)).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Sibling message navigation' }),
      ).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  /* Stop can win before the anchor exists in storage. The response would then
     hang off a row that was never written, so the abort persists nothing for
     it, and the run still settles instead of waiting on a final. */
  test('a stopped compaction whose anchor is not stored writes no orphaned response @scenario:stopped-compaction-without-stored-anchor-writes-no-orphan', async ({
    page,
    request,
  }) => {
    const { conversationId, leafUserId, stop } = await startCompactionOnUserLeaf(
      page,
      request,
      'missing-anchor',
    );
    try {
      await withMongo((db) =>
        db.collection('messages').deleteOne({ conversationId, messageId: leafUserId }),
      );

      const abort = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/agents/chat/abort',
        { timeout: 20_000 },
      );
      await stop.click();
      expect((await abort).ok()).toBeTruthy();
      await expect(stop).toBeHidden({ timeout: 20_000 });

      /* Neither the anchor nor a response parented on it may appear later. */
      await expect
        .poll(
          () =>
            withMongo((db) =>
              db.collection('messages').countDocuments({
                conversationId,
                $or: [{ messageId: leafUserId }, { parentMessageId: leafUserId }],
              }),
            ),
          { timeout: 5_000, intervals: [1_000] },
        )
        .toBe(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  /* An ordinary reply carries no compaction anchor: Stop keeps the user turn
     and the partial reply under it, as it did before. */
  test('a stopped ordinary reply keeps its turn and partial answer @scenario:stopped-reply-keeps-turn-and-partial-answer', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = `stopped-reply-${randomUUID().slice(0, 8)}`;
    const prompt = `E2E_SLOW_REPLY:${label}`;

    await page.goto('/c/new');
    const run = await sendMessage(page, prompt);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15_000 });
    const conversationId = new URL(page.url()).pathname.replace('/c/', '');

    try {
      const stop = page.getByTestId('stop-generation-button');
      await stop.click();
      await expect(stop).toBeHidden({ timeout: 20_000 });

      let reply: Row | null = null;
      await expect
        .poll(
          async () => {
            const user = await findRow({ conversationId, isCreatedByUser: true });
            if (!user) {
              return false;
            }
            reply = await findRow({
              conversationId,
              parentMessageId: user.messageId,
              isCreatedByUser: false,
            });
            return reply != null;
          },
          { timeout: 20_000 },
        )
        .toBeTruthy();
      expect(reply).not.toBeNull();

      await page.reload();
      await expect(messagesView(page).getByText(prompt)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText('chunk-010')).toBeVisible();
      await expect(page.getByTestId('stop-generation-button')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });
});
