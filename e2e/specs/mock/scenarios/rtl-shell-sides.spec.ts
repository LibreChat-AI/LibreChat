import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  deleteMessagesByConversation,
  deleteConversations,
  seedConversations,
  seedMessages,
  withMongo,
} from '../db';
import { getE2EUser } from '../../../setup/user';
import { getAccessToken, requestJson } from '../helpers';

/**
 * The shell sweep turned physical offsets (`-right-0.5`, `pl-*`, `text-left`) into
 * logical utilities, so an Arabic interface (`dir="rtl"`) mirrors them while English
 * renders exactly as before. The chat header is the observable: once a chat has a
 * shared link, its options button carries a dot on the corner at the header's
 * inline end. Assertions read rendered geometry, since a class name says nothing
 * about the side it lands on.
 *
 * The UI language is seeded the way a returning user arrives, through the stored
 * `lang` preference, and the dot is found by its test id because names are localized.
 */

const userEmail = getE2EUser().email;

type Locale = 'en' | 'ar';

async function withLanguage(page: Page, locale: Locale) {
  await page.addInitScript((value) => {
    window.localStorage.setItem('lang', JSON.stringify(value));
  }, locale);
}

/** A two-turn chat with an active shared link, created through the real share route. */
async function seedSharedChat(page: Page) {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  await seedConversations(userEmail, [
    { conversationId, title: `Shared sides ${conversationId.slice(0, 8)}`, updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Which side is the start?',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text: 'The one the text begins on.',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  await page.goto('/c/new', { timeout: 15_000 });
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/share/${conversationId}`,
    token,
    method: 'POST',
    body: { snapshotFiles: false },
  });
  return conversationId;
}

async function cleanup(conversationId: string) {
  await withMongo((db) => db.collection('sharedlinks').deleteMany({ conversationId }));
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

/** Where the shared-link dot sits relative to its button. Wide headers render it on
 *  the chat options button, narrow ones on the header menu button; both carry it. */
async function dotSide(page: Page) {
  const dot = page
    .locator(
      '[data-testid="header-shared-link-indicator"], [data-testid="header-menu-shared-link-indicator"]',
    )
    .filter({ visible: true })
    .first();
  await expect(dot).toBeVisible({ timeout: 15_000 });
  return dot.evaluate((element) => {
    const button = element.closest('button');
    if (!button) {
      throw new Error('the shared-link dot is not inside its button');
    }
    const host = button.getBoundingClientRect();
    const mark = element.getBoundingClientRect();
    return {
      direction: getComputedStyle(button).direction,
      dotCenter: mark.left + mark.width / 2,
      buttonCenter: host.left + host.width / 2,
      dotTop: mark.top,
      buttonTop: host.top,
    };
  });
}

async function openSharedChat(page: Page, locale: Locale) {
  const conversationId = await seedSharedChat(page);
  await withLanguage(page, locale);
  await page.goto(`/c/${conversationId}`, { timeout: 15_000 });
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
  return conversationId;
}

test.describe('logical sides in the app shell', () => {
  test('an Arabic interface puts the shared chat dot on the top-left corner of the chat options button @scenario:rtl-shared-chat-dot-on-inline-end', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    let conversationId: string | undefined;
    try {
      conversationId = await openSharedChat(page, 'ar');
      await expect.poll(async () => (await dotSide(page)).direction).toBe('rtl');
      const side = await dotSide(page);
      expect(side.dotCenter, 'the dot should sit left of centre (inline end)').toBeLessThan(
        side.buttonCenter,
      );
      expect(side.dotTop).toBeLessThan(side.buttonTop + 4);
    } finally {
      if (conversationId) {
        await cleanup(conversationId);
      }
    }
  });

  test('an English interface keeps the shared chat dot on the top-right corner @scenario:ltr-shared-chat-dot-unchanged', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    let conversationId: string | undefined;
    try {
      conversationId = await openSharedChat(page, 'en');
      const side = await dotSide(page);
      expect(side.direction).toBe('ltr');
      expect(side.dotCenter, 'the dot should sit right of centre').toBeGreaterThan(
        side.buttonCenter,
      );
      expect(side.dotTop).toBeLessThan(side.buttonTop + 4);
    } finally {
      if (conversationId) {
        await cleanup(conversationId);
      }
    }
  });
});
