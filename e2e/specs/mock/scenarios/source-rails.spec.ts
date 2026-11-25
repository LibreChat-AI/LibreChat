import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { deleteConversations, seedConversations, seedMessages } from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * The web search source rails scroll sideways when the sources outgrow the row. They hide
 * their scrollbar the way the other carousels do, and their links stay reachable by keyboard.
 */

const SOURCE_COUNT = 8;
const REGION_NAME = 'Search results and sources';

test.use({ viewport: { width: 360, height: 800 } });

/** A two-lane assistant turn, the shape that renders the sources region, with web search results. */
async function seedSourcesChat(title: string): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const organic = Array.from({ length: SOURCE_COUNT }, (_, index) => ({
    title: `Source ${index + 1}`,
    link: `https://source-${index + 1}.e2e.invalid/page`,
    snippet: `Snippet ${index + 1}`,
    attribution: `source-${index + 1}.e2e.invalid`,
  }));
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Search the web.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: assistantMessageId,
      parentMessageId: userMessageId,
      text: 'Two lanes answered.',
      isCreatedByUser: false,
      sender: 'Mock Provider A',
      content: [
        { type: 'text', text: 'Lane one answered.', groupId: 1, agentId: 'agent_lane_one' },
        { type: 'text', text: 'Lane two answered.', groupId: 1, agentId: 'agent_lane_two' },
      ],
      attachments: [
        {
          type: 'web_search',
          messageId: assistantMessageId,
          toolCallId: randomUUID(),
          conversationId,
          web_search: { turn: 0, organic, topStories: [], images: [], references: [] },
        },
      ],
    },
  ]);
  return conversationId;
}

test.describe('web search source rails', () => {
  test('the source rail scrolls sideways without drawing a scrollbar @scenario:source-rails-hide-scrollbar', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedSourcesChat('Source rails scrollbar');
    try {
      await page.goto(`/c/${conversationId}`);
      const region = page.getByRole('region', { name: REGION_NAME });
      await expect(region).toBeVisible({ timeout: 20000 });
      const rail = region
        .getByRole('link')
        .first()
        .locator('xpath=ancestor::div[contains(@class, "overflow-x-auto")][1]');
      const metrics = await rail.evaluate((node) => {
        node.style.width = '200px';
        return {
          overflowX: getComputedStyle(node).overflowX,
          scrollbarWidth: getComputedStyle(node).scrollbarWidth,
          overflowing: node.scrollWidth > node.clientWidth,
        };
      });
      expect(metrics).toEqual({ overflowX: 'auto', scrollbarWidth: 'none', overflowing: true });
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test('links in an overflowing source rail stay reachable by keyboard @scenario:source-rails-stay-keyboard-reachable', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversationId = await seedSourcesChat('Source rails keyboard');
    try {
      await page.goto(`/c/${conversationId}`);
      const region = page.getByRole('region', { name: REGION_NAME });
      await expect(region).toBeVisible({ timeout: 20000 });
      const last = region.getByRole('link', { name: /Source 3/ }).first();
      await region.getByRole('link').first().focus();
      for (let step = 0; step < 12; step++) {
        if (await last.evaluate((node) => node === document.activeElement)) {
          break;
        }
        await page.keyboard.press('Tab');
      }
      await expect(last).toBeFocused();
      await expect(last).toBeInViewport();
    } finally {
      await deleteConversations([conversationId]);
    }
  });
});
