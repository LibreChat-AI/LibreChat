import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { deleteConversations, seedConversations, seedMessages } from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * Image results under a web search keep the shape of their thumbnails: a card with reported
 * dimensions takes that ratio, and one without them falls back to a square.
 */

const WIDE_TITLE = 'Wide thumbnail';
const SQUARE_TITLE = 'Unsized thumbnail';

async function seedImageSearchChat(): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Search verticals', updatedAt: new Date() },
  ]);
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const toolCallId = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Find pictures.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: assistantMessageId,
      parentMessageId: userMessageId,
      text: 'Here are some pictures.',
      isCreatedByUser: false,
      sender: 'Mock Provider A',
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: toolCallId,
            name: 'web_search',
            args: JSON.stringify({ query: 'pictures' }),
            output: 'results',
            progress: 1,
            type: 'tool_call',
            runStepStatus: 'completed',
          },
        },
        { type: 'text', text: 'Here are some pictures.' },
      ],
      attachments: [
        {
          type: 'web_search',
          messageId: assistantMessageId,
          toolCallId,
          conversationId,
          web_search: {
            turn: 0,
            organic: [{ link: 'https://source.e2e.invalid/', title: 'A source' }],
            topStories: [],
            references: [],
            images: [
              {
                title: WIDE_TITLE,
                link: 'https://wide.e2e.invalid/page',
                thumbnailUrl: 'https://wide.e2e.invalid/thumb.png',
                thumbnailWidth: 160,
                thumbnailHeight: 90,
              },
              {
                title: SQUARE_TITLE,
                link: 'https://square.e2e.invalid/page',
                thumbnailUrl: 'https://square.e2e.invalid/thumb.png',
              },
            ],
          },
        },
      ],
    },
  ]);
  return conversationId;
}

test.describe('web search image results', () => {
  test('image cards keep their thumbnail ratio and fall back to square @scenario:search-image-cards-keep-thumbnail-ratio', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedImageSearchChat();
    try {
      await page.goto(`/c/${conversationId}`);
      const wide = page.getByRole('link', { name: WIDE_TITLE });
      const square = page.getByRole('link', { name: SQUARE_TITLE });
      await expect(wide).toBeVisible({ timeout: 20000 });
      await expect(square).toBeVisible();
      const [wideBox, squareBox] = await Promise.all([wide.boundingBox(), square.boundingBox()]);
      expect(wideBox).not.toBeNull();
      expect(squareBox).not.toBeNull();
      expect(wideBox!.height).toBeGreaterThan(0);
      expect(wideBox!.width / wideBox!.height).toBeCloseTo(16 / 9, 1);
      expect(squareBox!.width / squareBox!.height).toBeCloseTo(1, 1);
    } finally {
      await deleteConversations([conversationId]);
    }
  });
});
