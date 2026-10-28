import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
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
const ARABIC_PARAGRAPH = 'هذه فقرة عربية تشرح الشيفرة التالية.';
const ARABIC_HEADING = 'عنوان عربي';
const ENGLISH_PARAGRAPH = 'This English paragraph sits inside an Arabic reply.';
const CODE_LINE = 'const greeting = "hello"; // done.';

const REPLY_TEXT = [
  `## ${ARABIC_HEADING}`,
  '',
  `${ARABIC_PARAGRAPH} استخدم \`npm run build\` أولا.`,
  '',
  ENGLISH_PARAGRAPH,
  '',
  '```js',
  CODE_LINE,
  '```',
  '',
  '$$',
  'x^2 + y^2 = z^2',
  '$$',
  '',
  '> اقتباس عربي قصير',
  '',
  '- البند الأول',
  '',
  '- البند الثاني',
  '',
  '| العمود الأول | Second column |',
  '| --- | --- |',
  '| واحد | اثنان |',
].join('\n');

type Seeded = { conversationId: string };

async function seedReply(texts: string[]): Promise<Seeded> {
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messages: SeedMessage[] = [
    {
      messageId: userMessageId,
      parentMessageId: ROOT_PARENT,
      text: 'Explain the snippet',
      isCreatedByUser: true,
      sender: 'User',
    },
    ...texts.map((text) => ({
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text,
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
    })),
  ];
  const userEmail = getE2EUser().email;
  await seedConversations(userEmail, [
    { conversationId, title: 'RTL chat surface', updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, messages);
  return { conversationId };
}

async function cleanup({ conversationId }: Seeded) {
  await deleteMessagesByConversation([conversationId]);
  await deleteConversations([conversationId]);
}

async function openInLanguage(page: Page, lang: string, conversationId: string) {
  await page.addInitScript((value) => window.localStorage.setItem('lang', value), lang);
  await page.goto(`/c/${conversationId}`, { timeout: 10000 });
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
}

const reply = (page: Page) => messagesView(page).locator('.markdown').last();

const box = (locator: Locator) =>
  locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });

test.describe('RTL chat surface', () => {
  test('code, inline code and math in an Arabic reply keep left-to-right order @scenario:rtl-reply-code-and-math-stay-ltr', async ({
    page,
  }) => {
    const seeded = await seedReply([REPLY_TEXT]);
    try {
      await openInLanguage(page, 'ar', seeded.conversationId);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

      const markdown = reply(page);
      const paragraph = markdown.locator('p', { hasText: ARABIC_PARAGRAPH });
      await expect(paragraph).toHaveCSS('direction', 'rtl');

      const code = markdown.locator('pre code', { hasText: 'greeting' });
      await expect(code).toBeVisible();
      await expect(code).toHaveCSS('direction', 'ltr');
      await expect(code).toHaveCSS('unicode-bidi', 'isolate');

      const inline = paragraph.locator('code', { hasText: 'npm run build' });
      await expect(inline).toHaveCSS('direction', 'ltr');
      await expect(inline).toHaveCSS('unicode-bidi', 'isolate');

      const math = markdown.locator('.katex').first();
      await expect(math).toBeVisible();
      await expect(math).toHaveCSS('direction', 'ltr');
    } finally {
      await cleanup(seeded);
    }
  });

  test('each block of a mixed-language reply takes the direction of its own text @scenario:rtl-reply-blocks-resolve-their-own-direction', async ({
    page,
  }) => {
    const seeded = await seedReply([REPLY_TEXT]);
    try {
      await openInLanguage(page, 'ar', seeded.conversationId);
      const markdown = reply(page);

      const english = markdown.locator('p', { hasText: ENGLISH_PARAGRAPH });
      await expect(english).toHaveCSS('direction', 'ltr');
      const heading = markdown.locator('h2', { hasText: ARABIC_HEADING });
      await expect(heading).toHaveCSS('direction', 'rtl');

      /* The same reply in an English interface still lays the Arabic blocks right to left. */
      await page.evaluate(() => window.localStorage.setItem('lang', 'en-US'));
      await page.addInitScript(() => window.localStorage.setItem('lang', 'en-US'));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      await expect(reply(page).locator('h2', { hasText: ARABIC_HEADING })).toHaveCSS(
        'direction',
        'rtl',
      );
      await expect(reply(page).locator('p', { hasText: ENGLISH_PARAGRAPH })).toHaveCSS(
        'direction',
        'ltr',
      );
      /* A quote and a loose list wrap their text in paragraphs; they still follow it, and the
       * list indents from the side its markers sit on. */
      await expect(reply(page).locator('blockquote')).toHaveCSS('direction', 'rtl');
      const list = reply(page).locator('ul').first();
      await expect(list).toHaveCSS('direction', 'rtl');
      /* A table takes one direction from its content, so an English header shares the frame. */
      await expect(reply(page).locator('th').nth(1)).toHaveCSS('direction', 'rtl');
      expect(
        parseFloat(await list.evaluate((el) => getComputedStyle(el).paddingRight)),
      ).toBeGreaterThan(0);
    } finally {
      await cleanup(seeded);
    }
  });

  test('quote bar, list indent and table columns start from the right in Arabic @scenario:rtl-quote-list-and-table-mirror', async ({
    page,
  }) => {
    const seeded = await seedReply([REPLY_TEXT]);
    try {
      await openInLanguage(page, 'ar', seeded.conversationId);
      const markdown = reply(page);

      const quote = markdown.locator('blockquote');
      await quote.scrollIntoViewIfNeeded();
      await expect(quote).toHaveCSS('border-left-width', '0px');
      expect(
        parseFloat(await quote.evaluate((el) => getComputedStyle(el).borderRightWidth)),
      ).toBeGreaterThan(0);

      const list = markdown.locator('ul').first();
      await expect(list).toHaveCSS('direction', 'rtl');
      const listStyle = await list.evaluate((el) => {
        const style = getComputedStyle(el);
        return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
      });
      expect(listStyle.right).toBeGreaterThan(0);
      expect(listStyle.left).toBe(0);

      const headers = markdown.locator('th');
      await headers.first().scrollIntoViewIfNeeded();
      const first = await box(headers.nth(0));
      const second = await box(headers.nth(1));
      expect(first.left).toBeGreaterThan(second.left);
    } finally {
      await cleanup(seeded);
    }
  });

  test('an English interface keeps quotes, lists and tables starting from the left @scenario:ltr-reply-layout-unchanged', async ({
    page,
  }) => {
    const seeded = await seedReply([
      [
        '> A short quote',
        '',
        '- First item',
        '',
        '| First | Second |',
        '| --- | --- |',
        '| 1 | 2 |',
      ].join('\n'),
    ]);
    try {
      await openInLanguage(page, 'en-US', seeded.conversationId);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      const markdown = reply(page);

      const quote = markdown.locator('blockquote');
      await expect(quote).toHaveCSS('border-right-width', '0px');
      expect(
        parseFloat(await quote.evaluate((el) => getComputedStyle(el).borderLeftWidth)),
      ).toBeGreaterThan(0);

      const list = markdown.locator('ul').first();
      const paddingLeft = await list.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
      expect(paddingLeft).toBeGreaterThan(0);

      const headers = markdown.locator('th');
      const first = await box(headers.nth(0));
      const second = await box(headers.nth(1));
      expect(first.left).toBeLessThan(second.left);
    } finally {
      await cleanup(seeded);
    }
  });

  test('the previous and next reply arrows point outward from the counter in Arabic @scenario:rtl-sibling-switch-mirrors', async ({
    page,
  }) => {
    const seeded = await seedReply(['الرد الأول', 'الرد الثاني']);
    try {
      await openInLanguage(page, 'ar', seeded.conversationId);
      const view = messagesView(page);
      await expect(view.getByText('الرد الثاني')).toBeVisible();

      const previous = view.getByRole('button', { name: 'Previous sibling message' });
      const next = view.getByRole('button', { name: 'Next sibling message' });
      await expect(previous).toBeVisible();
      const previousBox = await box(previous);
      const nextBox = await box(next);
      expect(previousBox.left).toBeGreaterThan(nextBox.left);

      /* The chevrons are mirrored, so "previous" points right, away from the counter. */
      const scaleX = await previous
        .locator('svg')
        .evaluate((el) => parseFloat(getComputedStyle(el).scale));
      expect(scaleX).toBe(-1);

      await expect(view.getByRole('status').filter({ hasText: '2 / 2' })).toBeVisible();
      await previous.click();
      await expect(view.getByText('الرد الأول')).toBeVisible();
      await expect(view.getByRole('status').filter({ hasText: '1 / 2' })).toBeVisible();
    } finally {
      await cleanup(seeded);
    }
  });

  test('the virtualized chat list follows the interface direction @scenario:rtl-virtualized-list-follows-direction', async ({
    page,
  }) => {
    const seeded = await seedReply(['مرحبا']);
    try {
      await openInLanguage(page, 'ar', seeded.conversationId);
      const grid = page.locator('.ReactVirtualized__Grid').first();
      await expect(grid).toBeAttached();
      await expect(grid).toHaveCSS('direction', 'rtl');
    } finally {
      await cleanup(seeded);
    }
  });
});
