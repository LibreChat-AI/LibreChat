import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedMessages, withMongo } from '../db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  sendMessage,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

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

test.describe('compaction collision settlement', () => {
  test.afterEach(async ({ request }) => {
    const response = await request.post(`${LABEL_SERVER}/__e2e/reset`);
    expect(response.ok()).toBeTruthy();
  });

  /* A leaf in the preliminary-response shape (an id ending in `_`) is the id
     a failed turn's error row would take, so a failed compaction on it must
     record its failure without overwriting the leaf. The fixture summarizer
     returns blank output, which is how this harness fails a compaction. */
  test('a failed compaction on an underscore-shaped leaf keeps the leaf and shows the failure @scenario:failed-compaction-on-underscore-leaf-keeps-the-leaf', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/c/new');
    await sendMessageAndWaitForCompletion(page, 'tell me about collisions');
    const conversationId = new URL(page.url()).pathname.replace('/c/', '');
    expect(conversationId).not.toBe('new');

    try {
      const answer = await withMongo((db) =>
        db
          .collection('messages')
          .findOne({ conversationId, isCreatedByUser: false }, { sort: { createdAt: -1 } }),
      );
      expect(answer?.messageId).toBeTruthy();

      const leafId = `${randomUUID()}_`;
      const leafText = 'Compact this underscore-shaped leaf';
      await seedMessages(userEmail, conversationId, [
        {
          messageId: leafId,
          parentMessageId: answer?.messageId as string,
          text: leafText,
          isCreatedByUser: true,
          sender: 'User',
        },
      ]);

      const behavior = await request.post(`${LABEL_SERVER}/__e2e/behavior`, {
        data: { mode: 'blank' },
      });
      expect(behavior.ok()).toBeTruthy();

      await page.goto(`/c/${conversationId}`);
      await expect(messagesView(page).getByText(leafText)).toBeVisible();
      await page.getByTestId('token-usage').click();
      await page.getByRole('button', { name: 'Compact context' }).click();

      let failure: Row | null = null;
      await expect
        .poll(
          async () => {
            failure = await findRow({
              conversationId,
              parentMessageId: leafId,
              isCreatedByUser: false,
            });
            return failure != null;
          },
          { timeout: 60_000 },
        )
        .toBeTruthy();
      expect((failure as Row | null)?.messageId).not.toBe(leafId);
      await expect(
        messagesView(page).getByText('Could not compact the context', { exact: false }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('stop-generation-button')).toBeHidden({ timeout: 20_000 });

      /* The leaf keeps its author and text: the failure went to its own row. */
      const leaf = await findRow({ conversationId, messageId: leafId });
      expect(leaf?.isCreatedByUser).toBe(true);
      expect(leaf?.text).toBe(leafText);

      await page.reload();
      await expect(messagesView(page).getByText(leafText)).toBeVisible({ timeout: 20_000 });
      const row = page.locator(`[id="${(failure as Row | null)?.messageId as string}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.getByText('Could not compact the context', { exact: false })).toBeVisible();
      await expect(row.getByText('Summarizing...')).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });

  /* The settled-job guard only withholds compaction snapshots: an ordinary
     reply whose viewer left mid-stream still ends with its full answer. */
  test('an ordinary reply whose viewer leaves mid-stream still saves its full answer @scenario:abandoned-ordinary-reply-saves-its-full-answer', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const label = `abandoned-reply-${randomUUID().slice(0, 8)}`;
    const prompt = `E2E_SLOW_REPLY:${label}`;

    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const run = await sendMessage(page, prompt);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}(\?|$)/, { timeout: 15_000 });
    const conversationId = new URL(page.url()).pathname.replace('/c/', '');

    /* Closing the only viewer drops every subscriber while the run streams. */
    await page.close();

    try {
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
            return reply != null && reply.unfinished !== true;
          },
          { timeout: 90_000, intervals: [2_000] },
        )
        .toBeTruthy();

      const context = page.context();
      const viewer = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
      await viewer.goto(`/c/${conversationId}`);
      await expect(messagesView(viewer).getByText(prompt)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(viewer).getByText('chunk-159')).toBeVisible({ timeout: 20_000 });
    } finally {
      await cleanup(conversationId);
    }
  });
});
