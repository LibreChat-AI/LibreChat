import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * Rows more than a screen from the thread's viewport are skipped by the browser, so a change
 * that touches the whole thread costs only the rows near the reader. The thread must be the
 * same thread either way: the same height, with every row reachable.
 */

const TURNS = 80;
const turnText = (index: number) =>
  /** Uneven heights, none of them the fallback a never-measured row would get. */
  [`Turn ${index + 1} of the skipped thread`, ...Array(index % 5).fill('Another line.')].join(
    '\n\n',
  );

async function seedThread(): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Skipped rows', updatedAt: new Date() },
  ]);
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  const messages = Array.from({ length: TURNS }, (_, index) => {
    const messageId = randomUUID();
    const isCreatedByUser = index % 2 === 0;
    const message = {
      messageId,
      parentMessageId,
      text: turnText(index),
      isCreatedByUser,
      sender: isCreatedByUser ? 'User' : 'Mock Provider A',
    };
    parentMessageId = messageId;
    return message;
  });
  await seedMessages(email, conversationId, messages);
  return conversationId;
}

/** How each row stands: skipped or not, and whether any of it is inside the thread's viewport. */
const rowStates = (page: Page, conversationId: string) =>
  page.evaluate((id) => {
    const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
    if (!scroller) {
      throw new Error('thread not mounted');
    }
    const view = scroller.getBoundingClientRect();
    /** The sidebar's link to this conversation carries the same attribute as the thread. */
    const rows = scroller.querySelectorAll<HTMLElement>(
      `[data-conversation-id="${id}"] .message-render`,
    );
    return Array.from(rows, (row) => {
      const box = row.getBoundingClientRect();
      return {
        skipped: row.hasAttribute('data-offscreen'),
        contentVisibility: getComputedStyle(row).contentVisibility,
        inView: box.bottom > view.top && box.top < view.bottom,
        screensAway:
          Math.max(view.top - box.bottom, box.top - view.bottom, 0) / scroller.clientHeight,
      };
    });
  }, conversationId);

test.describe('rows far from the viewport', () => {
  let conversationId: string;

  test.beforeEach(async () => {
    conversationId = await seedThread();
  });

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('are skipped, and the rows a reader can see never are @scenario:rows-far-from-the-viewport-are-skipped', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    await expect(thread.locator('.message-render[data-offscreen]').first()).toBeAttached();

    const rows = await rowStates(page, conversationId);
    for (const row of rows) {
      expect(row.contentVisibility).toBe(row.skipped ? 'auto' : 'visible');
      if (row.inView) {
        expect(row.skipped).toBe(false);
      }
      /** The margin is one screen, so a row two screens off is always past it. */
      if (row.screensAway > 2) {
        expect(row.skipped).toBe(true);
      }
    }
    expect(rows.filter((row) => row.skipped).length).toBeGreaterThan(TURNS / 2);
  });

  test('keep the height they were laid out at, so the thread is as tall as with nothing skipped @scenario:skipped-rows-keep-their-height', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    await expect(thread.locator('.message-render[data-offscreen]').first()).toBeAttached();

    const heights = await page.evaluate((id) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-conversation-id="${id}"] .message-render`),
      );
      const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
      const read = () => ({
        thread: scroller?.scrollHeight ?? 0,
        rows: rows.map((row) => row.offsetHeight),
      });
      const skipping = read();
      const skipped = rows.filter((row) => row.hasAttribute('data-offscreen'));
      for (const row of skipped) {
        row.removeAttribute('data-offscreen');
      }
      const laidOut = read();
      for (const row of skipped) {
        row.setAttribute('data-offscreen', '');
      }
      return { skipping, laidOut, skipped: skipped.length };
    }, conversationId);

    expect(heights.skipped).toBeGreaterThan(0);
    expect(heights.skipping.rows).toEqual(heights.laidOut.rows);
    expect(heights.skipping.thread).toBe(heights.laidOut.thread);
    /** Uneven on purpose: equal heights would pass with every row at its fallback. */
    expect(new Set(heights.laidOut.rows).size).toBeGreaterThan(2);
  });

  test('are laid out again by the time a scroll brings them into view @scenario:skipped-rows-return-on-scroll', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    const first = thread.locator('.message-render').first();
    const last = thread.locator('.message-render').last();
    await expect(first).toHaveAttribute('data-offscreen', '');
    await expect(last).not.toHaveAttribute('data-offscreen');

    await thread
      .getByText('Turn 1 of the skipped thread', { exact: true })
      .scrollIntoViewIfNeeded();

    await expect(first).not.toHaveAttribute('data-offscreen');
    await expect(first).toBeInViewport();
    await expect(first).toHaveCSS('content-visibility', 'visible');
    await expect(last).toHaveAttribute('data-offscreen', '');
    for (const row of await rowStates(page, conversationId)) {
      if (row.inView) {
        expect(row.skipped).toBe(false);
      }
    }
  });

  /**
   * A row's toolbar is the costliest part of it to mount, and nobody can press one from across
   * the thread. The rows a long thread adds after its first commit leave it out until they come
   * within a screen of the viewport.
   */
  const toolbars = (page: Page, id: string) =>
    page.evaluate((conversation) => {
      const rows = document.querySelectorAll<HTMLElement>(
        `[data-conversation-id="${conversation}"] .message-render`,
      );
      return Array.from(rows, (row) => ({
        skipped: row.hasAttribute('data-offscreen'),
        buttons: row.querySelectorAll('.hover-button').length,
      }));
    }, id);

  test('have no toolbar yet, and every row near the reader has one @scenario:far-rows-have-no-toolbar-yet', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    await expect(thread.locator('.message-render[data-offscreen]').first()).toBeAttached();

    /** A row that came near after it mounted gets its toolbar between frames. */
    await expect
      .poll(async () =>
        (await toolbars(page, conversationId)).every((row) => row.skipped || row.buttons > 0),
      )
      .toBe(true);
    const rows = await toolbars(page, conversationId);
    expect(rows.filter((row) => row.buttons === 0).length).toBeGreaterThan(TURNS / 2);
    expect(rows[rows.length - 1].buttons).toBeGreaterThan(0);
  });

  test('gain their toolbar as a scroll brings them near, at the same height, and keep it @scenario:far-rows-gain-their-toolbar-on-scroll', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    /** The second turn is a reply, whose toolbar always has its copy button. */
    const reply = thread.locator('.message-render').nth(1);
    const copy = reply.getByRole('button', { name: 'Copy to clipboard' });
    await expect(reply).toHaveAttribute('data-offscreen', '');
    await expect(copy).toHaveCount(0);
    const height = await reply.evaluate((row: HTMLElement) => row.offsetHeight);

    await thread
      .getByText('Turn 1 of the skipped thread', { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(copy).toBeAttached();
    expect(await reply.evaluate((row: HTMLElement) => row.offsetHeight)).toBe(height);
    await reply.hover();
    await expect(copy).toHaveCSS('opacity', '1');

    await thread
      .getByText(`Turn ${TURNS} of the skipped thread`, { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(reply).toHaveAttribute('data-offscreen', '');
    await expect(copy).toBeAttached();
  });
});
