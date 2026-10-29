import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SeedMessage } from '../db';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { messagesView } from '../helpers';

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const RLI = '\u2067';
const LRI = '\u2066';
const PDI = '\u2069';
const ARABIC = 'مرحبا بالعالم';
const HEBREW = 'שלום';

/* Each quote opens with an isolate, so only rule P2 decides which strong character comes first. */
const QUOTES = {
  paired: `${RLI}hello${PDI} ${ARABIC} paired`,
  nested: `${LRI}hello ${RLI}${HEBREW}${PDI} world${PDI} ${ARABIC} nested`,
  open: `${RLI}hello ${ARABIC} open`,
};

const REPLY_TEXT = Object.values(QUOTES)
  .map((quote) => `> ${quote}`)
  .join('\n\n---\n\n');

type Seeded = { conversationId: string };

async function seedReply(): Promise<Seeded> {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messages: SeedMessage[] = [
    {
      messageId: userMessageId,
      parentMessageId: ROOT_PARENT,
      text: 'Quote it back',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text: REPLY_TEXT,
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
    },
  ];
  const userEmail = getE2EUser().email;
  await seedConversations(userEmail, [
    { conversationId, title: 'Bidi isolates', updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, messages);
  return { conversationId };
}

async function cleanup({ conversationId }: Seeded) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

const quote = (page: Page, label: string) =>
  messagesView(page).locator('.markdown').last().locator('blockquote', { hasText: label });

test.describe('Bidi isolates in replies', () => {
  test('a quote skips text inside isolates when it picks its direction, as the browser does @scenario:reply-quote-direction-skips-isolates', async ({
    page,
  }) => {
    const seeded = await seedReply();
    try {
      await page.addInitScript(() => window.localStorage.setItem('lang', 'en-US'));
      await page.goto(`/c/${seeded.conversationId}`, { timeout: 10000 });
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

      const expected = { paired: 'rtl', nested: 'rtl', open: 'ltr' } as const;
      for (const [label, direction] of Object.entries(expected)) {
        const block = quote(page, label);
        await expect(block).toBeVisible();
        await expect(block).toHaveCSS('direction', direction);
        /* The quote's paragraph resolves with the browser's own `dir="auto"`, so both agree. */
        await expect(block.locator('p')).toHaveCSS('direction', direction);
      }
      /* An unmatched isolate hides every strong character, so the quote inherits instead. */
      await expect(quote(page, 'open')).not.toHaveAttribute('dir', /.+/);
    } finally {
      await cleanup(seeded);
    }
  });
});
