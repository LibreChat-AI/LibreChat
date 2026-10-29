import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedMessages, withMongo } from '../db';
import { messagesView, sendMessageAndWaitForCompletion } from '../helpers';

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

test.describe('compaction snapshot modes', () => {
  test.afterEach(async ({ request }) => {
    const response = await request.post(`${LABEL_SERVER}/__e2e/reset`);
    expect(response.ok()).toBeTruthy();
  });

  /* The last viewer leaving a live compaction saves its snapshot in the live
     shape; the run then finishes on its own and its terminal row replaces the
     snapshot, so the reopened conversation shows a settled compaction. */
  test('a compaction whose viewer leaves mid-run still settles after it finishes @scenario:abandoned-compaction-settles-after-the-run', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await page.goto('/c/new');
    await sendMessageAndWaitForCompletion(page, 'tell me about abandoned compactions');
    const conversationId = new URL(page.url()).pathname.replace('/c/', '');
    expect(conversationId).not.toBe('new');

    try {
      const answer = await withMongo((db) =>
        db
          .collection('messages')
          .findOne({ conversationId, isCreatedByUser: false }, { sort: { createdAt: -1 } }),
      );
      expect(answer?.messageId).toBeTruthy();

      const leafId = randomUUID();
      const leafText = 'Compact this and walk away';
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
        data: { mode: 'ok', delayMs: 8_000 },
      });
      expect(behavior.ok()).toBeTruthy();

      await page.goto(`/c/${conversationId}`);
      await expect(messagesView(page).getByText(leafText)).toBeVisible();
      await page.getByTestId('token-usage').click();
      await page.getByRole('button', { name: 'Compact context' }).click();
      await expect(page.getByTestId('stop-generation-button')).toBeVisible({ timeout: 20_000 });

      /* Closing the only viewer drops every subscriber while the summary runs. */
      const context = page.context();
      await page.close();

      let compaction: Row | null = null;
      await expect
        .poll(
          async () => {
            compaction = await findRow({
              conversationId,
              parentMessageId: leafId,
              isCreatedByUser: false,
            });
            return compaction != null && compaction.unfinished !== true;
          },
          { timeout: 60_000, intervals: [2_000] },
        )
        .toBeTruthy();
      expect((compaction as Row | null)?.error).not.toBe(true);

      const leaf = await findRow({ conversationId, messageId: leafId });
      expect(leaf?.isCreatedByUser).toBe(true);
      expect(leaf?.text).toBe(leafText);

      const viewer = await context.newPage();
      await viewer.goto(`/c/${conversationId}`);
      await expect(messagesView(viewer).getByText(leafText)).toBeVisible({ timeout: 20_000 });
      const row = viewer.locator(`[id="${(compaction as Row | null)?.messageId as string}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.getByText('Summarizing...')).toHaveCount(0);
      await expect(row.getByText('Could not compact the context', { exact: false })).toHaveCount(0);
    } finally {
      await cleanup(conversationId);
    }
  });
});
