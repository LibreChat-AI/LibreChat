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
 * A long thread mounts in steps, so for a moment after it opens some of its rows are not in the
 * document, and the copy-last-code shortcut reads the document. Opened at its end, a thread is
 * missing its oldest rows: with its only code block in one of those the shortcut found
 * nothing, copied nothing and let the key press through. Opened at its start (auto-scroll off),
 * it is missing its latest rows, and the shortcut copied an older block than the last one.
 */

const TURNS = 800;
const CODE = 'const only = "block";';
const LATEST = 'const latest = "block";';

const fenced = (code: string) => `Some code:\n\n\`\`\`js\n${code}\n\`\`\`\n`;

/** A thread with a code block in its first reply and, when given one, another in its last. */
async function seedThread(latest?: string): Promise<string> {
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
      text: codeAt(index, latest) ?? `Turn ${index + 1} of the thread`,
      isCreatedByUser,
      sender: isCreatedByUser ? 'User' : 'Mock Provider A',
    };
    parentMessageId = messageId;
    return message;
  });
  await seedMessages(email, conversationId, messages);
  return conversationId;
}

function codeAt(index: number, latest?: string): string | undefined {
  if (index === 1) {
    return fenced(CODE);
  }
  return latest != null && index === TURNS - 1 ? fenced(latest) : undefined;
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

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('copies a block from a row the thread had not mounted yet @scenario:copy-last-code-while-thread-mounts', async ({
    page,
  }, info) => {
    conversationId = await seedThread();
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
    conversationId = await seedThread();
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

  test('copies the latest block of a thread opened at its start, not an older one @scenario:copy-last-code-while-thread-mounts-from-its-start', async ({
    page,
  }) => {
    /** With auto-scroll off a thread opens on its first turn and mounts towards its end. */
    await page.addInitScript(() => window.localStorage.setItem('autoScroll', 'false'));
    conversationId = await seedThread(LATEST);
    await page.goto(`/c/${conversationId}`);
    await page.evaluate(() => navigator.clipboard.writeText('nothing copied'));
    const rows = page.locator('.message-render');
    await page.waitForFunction(
      () => document.getElementsByClassName('message-render').length >= 16,
    );
    /** The first reply and its block are in from the first step; the last reply is not. */
    await expect(rows.first()).toBeInViewport();
    await copyLastCode(page);

    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LATEST);
    expect(await mountedRows(page)).toBe(TURNS);
    /** The latest rows landed below the reader, who is still on the first turn. */
    await expect(rows.first()).toBeInViewport();
  });
});
