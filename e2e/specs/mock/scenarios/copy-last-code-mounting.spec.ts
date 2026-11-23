import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { MOCK_ENDPOINTS, selectMockEndpoint, sendMessage } from '../helpers';
import { getE2EUser } from '../../../setup/user';

/**
 * A long thread mounts from its end in steps, so for a moment after it opens its oldest rows
 * are not in the document. The copy-last-code shortcut reads the document: with the thread's
 * only code block in one of those rows it found nothing, copied nothing and let the key press
 * through, where the same press a second later copied the block.
 */

const TURNS = 800;
const CODE = 'const only = "block";';

/** A thread whose one code block is in its first reply, the last row to mount. */
async function seedThread(): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Code far back', updatedAt: new Date() },
  ]);
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  const messages = Array.from({ length: TURNS }, (_, index) => {
    const messageId = randomUUID();
    const isCreatedByUser = index % 2 === 0;
    const message = {
      messageId,
      parentMessageId,
      text:
        index === 1
          ? `The only code in this thread:\n\n\`\`\`js\n${CODE}\n\`\`\`\n`
          : `Turn ${index + 1} of the thread`,
      isCreatedByUser,
      sender: isCreatedByUser ? 'User' : 'Mock Provider A',
    };
    parentMessageId = messageId;
    return message;
  });
  await seedMessages(email, conversationId, messages);
  return conversationId;
}

/**
 * The shortcut is one the composer keeps to itself while it has focus, and the composer takes
 * focus as a chat opens: press it as a reader who is in the thread, not typing.
 */
async function copyLastCode(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+Shift+K');
}

const mountedRows = (page: Page) =>
  page.evaluate(() => document.getElementsByClassName('message-render').length);

test.describe('copy last code in a long thread', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  test.setTimeout(120_000);

  let conversationId: string;

  test.beforeEach(async () => {
    conversationId = await seedThread();
  });

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('copies a block from a row the thread had not mounted yet @scenario:copy-last-code-while-thread-mounts', async ({
    page,
  }, info) => {
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    /** The thread has opened on its latest rows and is still bringing in the rest. */
    await page.waitForFunction(
      () => document.getElementsByClassName('message-render').length >= 16,
    );
    const before = await mountedRows(page);
    await copyLastCode(page);
    const after = await mountedRows(page);
    info.annotations.push({ type: 'rows at the key press', description: `${before} of ${TURNS}` });

    /** The press copied the block, having brought the rest of the thread in to find it. */
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
    expect(after).toBe(TURNS);
    /** The reader is still where the thread opened: on its latest turn. */
    await expect(page.locator('.message-render').last()).toBeInViewport();
  });

  test('keeps a reader who scrolled up beside a reply where they were @scenario:copy-last-code-holds-the-reader-beside-a-reply', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    const rows = page.locator('.message-render');
    await expect(rows).toHaveCount(TURNS, { timeout: 60_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    /** Ten seconds pass before each of this reply's tokens: the run is in flight throughout. */
    await sendMessage(page, `E2E_PRE_TOKEN_REPLY:${randomUUID().slice(0, 8)}`);
    const stop = page.getByTestId('stop-generation-button');
    await expect(stop).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    /** Mounting, and landed on its end: the open's own scroll there is not the reader's. */
    await page.waitForFunction(() => {
      const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
      return (
        scroller != null &&
        document.getElementsByClassName('message-render').length >= 40 &&
        scroller.scrollTop > 0 &&
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
      );
    });
    const view = await page.getByTestId('messages-view').boundingBox();
    await page.mouse.move((view?.x ?? 0) + (view?.width ?? 800) / 2, (view?.y ?? 0) + 300);
    await page.mouse.wheel(0, -1200);
    /** A wheel scroll is animated: let it land before reading where it left the reader. */
    await page.waitForTimeout(400);
    const top = () =>
      page.evaluate(() => {
        const marked =
          document.querySelector('[data-reading]') ??
          Array.from(document.getElementsByClassName('message-render')).find(
            (row) => row.getBoundingClientRect().top > 80,
          );
        marked?.setAttribute('data-reading', '');
        return marked?.getBoundingClientRect().top ?? Number.NaN;
      });
    const before = await top();
    await copyLastCode(page);
    const after = await top();

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE);
    await expect(rows).toHaveCount(TURNS + 2);
    /** Hundreds of rows landed above the row they were reading, tens of thousands of pixels
     *  of them. Stepping beside a reply lets a row slip a few pixels between the two
     *  readings; a reader who lost their place is a screen or more away. */
    expect(Math.abs(after - before)).toBeLessThanOrEqual(60);
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 30_000 });
  });
});
