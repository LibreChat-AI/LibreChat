import { expect, test } from '@playwright/test';

import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

const ORDERED_PIECE_COUNT = 64;

const orderedReplyPieces = Array.from(
  { length: ORDERED_PIECE_COUNT },
  (_, index) => `piece-${String(index).padStart(3, '0')}`,
);

test.describe('content handler message reconciliation', () => {
  test('keeps streamed replies ordered and visible after a follow-up turn and reload @scenario:streamed-replies-render-in-order-and-survive-reload', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const label = `content-handler-${Date.now()}`;
    const orderedPrompt = `E2E_ORDERED_REPLY:${label}`;
    const orderedReply = `E2E ordered reply ${label} ${orderedReplyPieces.join(' ')}`;

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const firstResponse = await sendMessageAndWaitForCompletion(page, orderedPrompt);
    expect(firstResponse.ok()).toBeTruthy();
    const messageRows = messagesView(page).locator('.message-render');
    await expect(messageRows.last().locator('.message-content')).toHaveText(orderedReply, {
      timeout: 30_000,
    });

    const secondResponse = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(secondResponse.ok()).toBeTruthy();
    await expect(messageRows.last().locator('.message-content')).toHaveText(replyText(label), {
      timeout: 30_000,
    });
    await expect(messageRows).toHaveCount(4);

    await page.reload({ timeout: 10_000 });
    await expect(messageRows).toHaveCount(4, { timeout: 30_000 });
    await expect(messageRows.nth(1).locator('.message-content')).toHaveText(orderedReply, {
      timeout: 30_000,
    });
    await expect(messageRows.last().locator('.message-content')).toHaveText(replyText(label), {
      timeout: 30_000,
    });
  });
});
