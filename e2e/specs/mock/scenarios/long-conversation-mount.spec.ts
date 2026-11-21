import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import {
  replyText,
  replyPrompt,
  sendMessage,
  MOCK_ENDPOINTS,
  selectMockEndpoint,
} from '../helpers';
import { getE2EUser } from '../../../setup/user';

/** Past the row count at which the thread mounts progressively instead of all at once. */
const TURNS = 60;

/** A user turn long enough to be collapsed to a preview once it has measured itself. */
const LONG_TURN = Array.from({ length: 60 }, (_, line) => `A long turn, line ${line + 1}.`).join(
  '\n\n',
);

async function seedLongChat(turns = TURNS, longEvery = 0): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Long conversation', updatedAt: new Date() },
  ]);
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  const messages = Array.from({ length: turns }, (_, index) => {
    const messageId = randomUUID();
    const isCreatedByUser = index % 2 === 0;
    const message = {
      messageId,
      parentMessageId,
      text:
        longEvery > 0 && isCreatedByUser && index % longEvery === 0
          ? LONG_TURN
          : `Turn ${index + 1} of the long conversation`,
      isCreatedByUser,
      sender: isCreatedByUser ? 'User' : 'Mock Provider A',
    };
    parentMessageId = messageId;
    return message;
  });
  await seedMessages(email, conversationId, messages);
  return conversationId;
}

test.describe('long conversations', () => {
  let conversationId: string;

  test.beforeEach(async () => {
    conversationId = await seedLongChat();
  });

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('a long conversation mounts every turn and its latest turn is reachable @scenario:long-conversation-mounts-every-turn', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);

    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(
      thread.getByText('Turn 1 of the long conversation', { exact: true }),
    ).toBeVisible();
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);

    const latest = thread.getByText(`Turn ${TURNS} of the long conversation`, { exact: true });
    await latest.scrollIntoViewIfNeeded();
    await expect(latest).toBeInViewport();
  });

  test('the scroll control appears once the reader scrolls up and lands on the latest turn @scenario:scroll-control-lands-on-the-latest-turn', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);

    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    const latest = thread.getByText(`Turn ${TURNS} of the long conversation`, { exact: true });
    await thread
      .getByText('Turn 1 of the long conversation', { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(latest).not.toBeInViewport();

    /** The thread's own control, not the navigation rail's end marker, which shares its name. */
    const scrollControl = page
      .getByRole('button', { name: 'Scroll to bottom' })
      .and(page.locator(':not([data-msg-id])'));
    await expect(scrollControl).toBeEnabled();
    await scrollControl.click();

    await expect(latest).toBeInViewport();
    await expect(scrollControl).toBeHidden();
  });

  test('opening a long conversation lands on its latest turn @scenario:long-conversation-opens-at-its-latest-turn', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);

    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);

    await expect(
      thread.getByText(`Turn ${TURNS} of the long conversation`, { exact: true }),
    ).toBeInViewport();
    await expect(
      thread.getByText('Turn 1 of the long conversation', { exact: true }),
    ).not.toBeInViewport();
  });

  test('a reply sent from the top of a long conversation is followed into view @scenario:sent-reply-is-followed-into-view', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);

    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const first = thread.getByText('Turn 1 of the long conversation', { exact: true });
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport();

    const label = randomUUID().slice(0, 8);
    await sendMessage(page, replyPrompt(label));

    const reply = thread.getByText(replyText(label));
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(reply).toBeInViewport();
    await expect(first).not.toBeInViewport();
  });

  test.describe('on a desktop viewport, where the navigation rail shows', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

    test('the navigation rail jumps to the first turn and back to the latest @scenario:message-nav-jumps-between-ends', async ({
      page,
    }) => {
      await page.goto(`/c/${conversationId}`);

      const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
      await expect(thread.locator('.message-render')).toHaveCount(TURNS);
      const first = thread.getByText('Turn 1 of the long conversation', { exact: true });
      const latest = thread.getByText(`Turn ${TURNS} of the long conversation`, { exact: true });
      await expect(latest).toBeInViewport();

      const rail = page.getByRole('navigation', { name: 'Message navigation' });
      await expect(rail.getByRole('button', { name: 'Navigate to next message' })).toBeDisabled();
      await rail.getByRole('button', { name: 'Scroll to top' }).click();
      await expect(first).toBeInViewport();
      await expect(
        rail.getByRole('button', { name: 'Navigate to previous message' }),
      ).toBeDisabled();

      await rail.getByRole('button', { name: 'Scroll to bottom' }).click();
      await expect(latest).toBeInViewport();
    });
  });
});

/**
 * A conversation with a reply in flight is the one a reader comes back to. It mounts in steps
 * like any other long thread, in smaller ones beside the reply: every row in one commit froze
 * the page for as long as the whole thread takes to render.
 */
test.describe('a long conversation with a reply in flight', () => {
  /** Enough turns that one commit for the rest of the thread is unmistakable. */
  const MANY = 160;
  /** The largest step the thread takes: a chunk of rows once nothing is streaming. */
  const LARGEST_STEP = 32;
  let conversationId: string;

  test.beforeEach(async () => {
    conversationId = await seedLongChat(MANY);
  });

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('mounts in steps when it is opened, and stays on the reply @scenario:long-conversation-mounts-in-steps-beside-a-reply', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(MANY);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** Ten seconds pass before each of this reply's tokens: the run is in flight for the
     *  whole of the load below, however slow the machine. */
    const label = randomUUID().slice(0, 8);
    await sendMessage(page, `E2E_PRE_TOKEN_REPLY:${label}`);
    const stop = page.getByTestId('stop-generation-button');
    await expect(stop).toBeVisible({ timeout: 30_000 });

    /** Rows in the document at each frame of the next load. */
    await page.addInitScript(() => {
      const counts: number[] = [];
      (window as unknown as { __rows: number[] }).__rows = counts;
      const rows = document.getElementsByClassName('message-render');
      const sample = () => {
        if (counts[counts.length - 1] !== rows.length) {
          counts.push(rows.length);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.reload();

    /** Still under way when the thread comes back, and the thread rests on its end. */
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(thread.locator('.message-render')).toHaveCount(MANY + 2, { timeout: 30_000 });
    await expect(thread.locator('.message-render').last()).toBeInViewport();

    const counts = await page.evaluate(() => (window as unknown as { __rows: number[] }).__rows);
    const steps = counts.slice(1).map((count, index) => count - counts[index]);
    expect(Math.max(...steps)).toBeLessThanOrEqual(LARGEST_STEP);
    expect(steps.length).toBeGreaterThan(MANY / LARGEST_STEP);

    /** Every row is in and the run is still under way: the thread did not wait for it. */
    await expect(stop).toBeVisible();
    await expect(
      thread.getByText('Turn 1 of the long conversation', { exact: true }),
    ).not.toBeInViewport();
    await stop.click();
    await expect(stop).toBeHidden({ timeout: 30_000 });
    await expect(thread.locator('.message-render').last()).toBeInViewport();
  });
});

/**
 * A reader who scrolls up while the rest of a long thread is still mounting is obeyed, and
 * stays where they stopped. Rows keep mounting above them, some of which change height once
 * more after they mount: a long user turn collapses to a preview. Holding the reader by writing
 * the scroll position on every step cancelled the scroll they were making, and counted such a
 * turn at its full height.
 */
test.describe('a reader scrolling up while a long conversation mounts', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  const MANY = 600;
  let conversationId: string;

  test.beforeEach(async () => {
    conversationId = await seedLongChat(MANY, 20);
  });

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('keeps their place as rows mount above them @scenario:reader-keeps-place-while-long-conversation-mounts', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
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
    await page.mouse.wheel(0, -1500);
    /** A wheel scroll is animated: let it land before reading where it left the reader. */
    await page.waitForTimeout(400);

    const marked = await page.evaluate(() => {
      const rows = Array.from(document.getElementsByClassName('message-render'));
      const row = rows.find((candidate) => candidate.getBoundingClientRect().top > 80);
      row?.setAttribute('data-reading', '');
      const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
      return {
        top: row?.getBoundingClientRect().top ?? Number.NaN,
        mounted: rows.length,
        fromEnd: scroller
          ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
          : Number.NaN,
      };
    });
    /** Read while the thread was still arriving, or the wait below proves nothing. */
    expect(marked.mounted).toBeLessThan(MANY);
    /** The scroll was obeyed: the reader is a good way above the end. */
    expect(marked.fromEnd).toBeGreaterThan(1000);

    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(MANY, { timeout: 60_000 });
    const top = await page
      .locator('[data-reading]')
      .evaluate((row) => row.getBoundingClientRect().top);
    expect(Math.abs(top - marked.top)).toBeLessThanOrEqual(2);
  });

  /**
   * Scrolling past the rows mounted so far, or pressing Home, puts the reader at the very top
   * of the scroller, which is the one place a browser's scroll anchoring holds nothing: it
   * selects no anchor at the scroll origin. Left to it, the reader stays at the top of each chunk as it arrives and
   * the row they had reached moves away below them.
   */
  test('keeps the row they reached when they scroll past the rows mounted so far @scenario:reader-keeps-row-after-scrolling-past-mounted-rows', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);
    await page.waitForFunction(() => {
      const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
      return (
        scroller != null &&
        document.getElementsByClassName('message-render').length >= 40 &&
        scroller.scrollTop > 0 &&
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 1
      );
    });
    /** Home, in effect: straight to the top, and the row found there read in the same turn,
     *  before the next chunk can arrive. */
    const marked = await page.evaluate(() => {
      const scroller = document.getElementById('messages-end')?.parentElement?.parentElement;
      if (scroller) {
        scroller.scrollTop = 0;
      }
      const rows = document.getElementsByClassName('message-render');
      rows[0]?.setAttribute('data-reached', '');
      return { top: rows[0]?.getBoundingClientRect().top ?? Number.NaN, mounted: rows.length };
    });
    /** Read while the thread was still arriving, or the wait below proves nothing. */
    expect(marked.mounted).toBeLessThan(MANY);

    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(MANY, { timeout: 60_000 });
    const reached = page.locator('[data-reached]');
    await expect(reached).toBeInViewport();
    const top = await reached.evaluate((row) => row.getBoundingClientRect().top);
    expect(Math.abs(top - marked.top)).toBeLessThanOrEqual(2);
  });
});

/**
 * In a window tall enough that the rows a long thread opens on do not fill it, there is nothing
 * to scroll yet and the scroller sits at its origin, where a browser's scroll anchoring holds
 * nothing. The rows that mount above must still leave the thread on its latest turn.
 */
test.describe('a long conversation opened in a tall window', () => {
  test.use({ viewport: { width: 1280, height: 2400 }, isMobile: false, hasTouch: false });

  let conversationId: string;

  test.beforeEach(async () => {
    conversationId = await seedLongChat();
  });

  test.afterEach(async () => {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  });

  test('stays on its latest turn as the rest mounts above @scenario:long-conversation-in-a-tall-window-stays-on-its-latest-turn', async ({
    page,
  }) => {
    await page.goto(`/c/${conversationId}`);

    const thread = page.locator(`[data-conversation-id="${conversationId}"]`);
    await expect(thread.locator('.message-render')).toHaveCount(TURNS);
    await expect(
      thread.getByText(`Turn ${TURNS} of the long conversation`, { exact: true }),
    ).toBeInViewport();
    await expect(
      thread.getByText('Turn 1 of the long conversation', { exact: true }),
    ).not.toBeInViewport();
  });
});
