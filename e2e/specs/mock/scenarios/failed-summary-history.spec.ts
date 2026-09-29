import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';
import { messagesView, sendMessageAndWaitForCompletion } from '../helpers';

const summaryPart = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'summary',
  content: [{ type: 'text', text }],
  tokenCount: 6,
  ...extra,
});

/** Only a completed round's final summary block carries a boundary; the deltas a
 *  failed or interrupted round leaves behind never do. */
const completedBoundary = { messageId: 'step_summary', contentIndex: 0 };

/** A real turn carrying a passphrase only this conversation's history holds. */
async function startConversation(page: Page) {
  const token = `OLDFACT-${randomUUID().slice(0, 8)}`;
  await page.goto('/c/new');
  await sendMessageAndWaitForCompletion(page, `Remember this passphrase: ${token}`);
  const conversationId = new URL(page.url()).pathname.replace('/c/', '');
  expect(conversationId).not.toBe('new');
  return { conversationId, token };
}

/**
 * Appends a turn whose only content is a summary part, cloning the endpoint and
 * model of the turn it hangs off. A summarize round that streamed deltas and
 * then errored cannot be produced through the composer, and the behavior under
 * test is what the *next* turn sends once such a turn is persisted.
 */
async function appendSummaryTurn(conversationId: string, part: Record<string, unknown>) {
  await withMongo(async (db) => {
    const rows = await db
      .collection('messages')
      .find({ conversationId })
      .sort({ createdAt: 1 })
      .toArray();
    const leaf = rows[rows.length - 1];
    if (!leaf) {
      throw new Error(`E2E seed: conversation ${conversationId} has no messages`);
    }
    /** Mongo assigns the new row its own `_id`; everything else (endpoint,
     *  model, user, conversation) is cloned from the turn it hangs off. */
    const fields = { ...leaf };
    delete fields._id;
    const now = new Date();
    await db.collection('messages').insertOne({
      ...fields,
      messageId: randomUUID(),
      parentMessageId: leaf.messageId,
      isCreatedByUser: false,
      text: '',
      content: [part],
      createdAt: now,
      updatedAt: now,
    });
  });
}

test.describe('failed summary history', () => {
  const conversationIds: string[] = [];

  test.afterEach(async () => {
    const ids = conversationIds.splice(0);
    if (ids.length === 0) {
      return;
    }
    try {
      await deleteMessagesByConversation(ids);
    } finally {
      await deleteConversations(ids);
    }
  });

  /**
   * A summarize round that errored keeps the deltas it streamed and is stamped
   * `failed: true`. Taking that prefix as the conversation's history boundary
   * drops every turn it never summarized, so the passphrase from the opening
   * turn has to still reach the model on the turn after it.
   */
  test('a turn after a failed summarization still sends the earlier history @scenario:failed-summary-keeps-prior-history', async ({
    page,
  }) => {
    const { conversationId, token } = await startConversation(page);
    conversationIds.push(conversationId);
    await appendSummaryTurn(
      conversationId,
      summaryPart('Partial summary of the conve', { failed: true }),
    );

    await page.goto(`/c/${conversationId}`);
    await expect(messagesView(page).getByText(token)).toBeVisible();
    await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${token}`);

    await expect(
      messagesView(page).getByText(`E2E history assertion present: ${token}`),
    ).toBeVisible({ timeout: 30000 });
  });

  /**
   * The same rule for a round that never reported at all: the part is left
   * mid-stream (`summarizing: true`) with whatever text it produced, which is
   * no more a checkpoint than an errored round's prefix.
   */
  test('a turn after an interrupted summarization still sends the earlier history @scenario:unfinished-summary-keeps-prior-history', async ({
    page,
  }) => {
    const { conversationId, token } = await startConversation(page);
    conversationIds.push(conversationId);
    await appendSummaryTurn(
      conversationId,
      summaryPart('Partial summary of the conve', { summarizing: true }),
    );

    await page.goto(`/c/${conversationId}`);
    await expect(messagesView(page).getByText(token)).toBeVisible();
    await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${token}`);

    await expect(
      messagesView(page).getByText(`E2E history assertion present: ${token}`),
    ).toBeVisible({ timeout: 30000 });
  });

  /**
   * The other half of the same invariant: a summary that completed is still the
   * conversation's checkpoint, so the turns it covers are replaced by it and
   * the passphrase no longer reaches the model.
   */
  /**
   * Errored rounds were only stamped `failed` from #14546 on. One stored
   * earlier kept its streamed deltas with no flag at all, so the only record that
   * it never finished is the boundary a completed block would have written.
   */
  test('a turn after a summarization stored without a boundary still sends the earlier history @scenario:unstamped-summary-keeps-prior-history', async ({
    page,
  }) => {
    const { conversationId, token } = await startConversation(page);
    conversationIds.push(conversationId);
    await appendSummaryTurn(conversationId, summaryPart('Partial summary of the conve'));

    await page.goto(`/c/${conversationId}`);
    await expect(messagesView(page).getByText(token)).toBeVisible();
    await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${token}`);

    await expect(
      messagesView(page).getByText(`E2E history assertion present: ${token}`),
    ).toBeVisible({ timeout: 30000 });
  });

  test('a completed summary still replaces the history it covers @scenario:complete-summary-replaces-prior-history', async ({
    page,
  }) => {
    const { conversationId, token } = await startConversation(page);
    conversationIds.push(conversationId);
    await appendSummaryTurn(
      conversationId,
      summaryPart('The user shared a passphrase and it was acknowledged.', {
        boundary: completedBoundary,
      }),
    );

    await page.goto(`/c/${conversationId}`);
    await expect(messagesView(page).getByText(token)).toBeVisible();
    await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${token}`);

    await expect(
      messagesView(page).getByText(`E2E history assertion absent: ${token}`),
    ).toBeVisible({ timeout: 30000 });
  });
});
