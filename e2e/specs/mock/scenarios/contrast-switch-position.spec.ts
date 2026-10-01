import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';

/**
 * The band the message column reserves is not a constant of the platform: the
 * contrast modes widen the app's own scrollbar. A reader who turns contrast on
 * while the welcome screen is the only thing mounted has no message column to
 * republish that width, so the welcome screen must remeasure it itself — or the
 * first conversation corrects it and the composer steps sideways.
 */

const COMPOSER = '[data-testid="composer-surface"]';
const CONVERSATION_TITLE = 'Contrast switch';

test.use({ viewport: { width: 1280, height: 800 } });

type Box = { left: number; width: number };

const boxOf = (page: Page): Promise<Box> =>
  page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) {
      throw new Error(`${selector} is not rendered`);
    }
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
    };
  }, COMPOSER);

async function settle(page: Page): Promise<Box> {
  let previous = await boxOf(page);
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(200);
    const next = await boxOf(page);
    if (Math.abs(next.left - previous.left) < 0.5 && Math.abs(next.width - previous.width) < 0.5) {
      return next;
    }
    previous = next;
  }
  throw new Error(`the composer never settled: ${JSON.stringify(previous)}`);
}

test.describe('contrast switch', () => {
  test('the composer holds its position across a contrast switch @scenario:composer-holds-position-across-a-contrast-switch', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    const { email } = getE2EUser();
    await seedConversations(email, [
      { conversationId, title: CONVERSATION_TITLE, updatedAt: new Date() },
    ]);
    const userMessageId = randomUUID();
    await seedMessages(email, conversationId, [
      {
        messageId: userMessageId,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Does contrast move the composer?',
        isCreatedByUser: true,
        sender: 'User',
      },
      {
        messageId: randomUUID(),
        parentMessageId: userMessageId,
        text: 'It should not.',
        isCreatedByUser: false,
        sender: 'Mock Provider A',
      },
    ]);

    try {
      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      await settle(page);

      /** The OS contrast preference, changed while the welcome screen is up. */
      await page.emulateMedia({ contrast: 'more' });
      await expect(page.locator('html.high-contrast')).toHaveCount(1, { timeout: 10000 });
      const onWelcome = await settle(page);

      const row = page.getByTestId('convo-item').filter({ hasText: CONVERSATION_TITLE }).first();
      await expect(row).toBeVisible({ timeout: 20000 });
      await row.click();
      await expect(page.locator('.message-render').first()).toBeVisible({ timeout: 20000 });
      const inConversation = await settle(page);

      expect(inConversation.left).toBeCloseTo(onWelcome.left, 0);
      expect(inConversation.width).toBeCloseTo(onWelcome.width, 0);
    } finally {
      await page.emulateMedia({ contrast: null });
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
