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

async function seedLongChat(turns = TURNS): Promise<string> {
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
      text: `Turn ${index + 1} of the long conversation`,
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
