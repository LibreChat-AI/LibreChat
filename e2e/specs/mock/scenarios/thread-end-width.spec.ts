import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  seedMessages,
  seedConversations,
  deleteConversations,
  deleteMessagesByConversation,
} from '../db';
import { getE2EUser } from '../../../setup/user';

const TURNS = 30;
/** Long enough that a narrower thread wraps every reply onto more lines. */
const PARAGRAPH = Array.from(
  { length: 12 },
  (_, index) =>
    `Sentence ${index + 1} of a reply that runs the full width of the thread and wraps again when it narrows.`,
).join(' ');

async function seedLongChat(): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [
    { conversationId, title: 'Thread end across a width change', updatedAt: new Date() },
  ]);
  let parentMessageId = '00000000-0000-0000-0000-000000000000';
  const messages = Array.from({ length: TURNS }, (_, index) => {
    const messageId = randomUUID();
    const isCreatedByUser = index % 2 === 0;
    const message = {
      messageId,
      parentMessageId,
      text: isCreatedByUser ? `Question ${index / 2 + 1}` : PARAGRAPH,
      isCreatedByUser,
      sender: isCreatedByUser ? 'User' : 'Mock Provider A',
    };
    parentMessageId = messageId;
    return message;
  });
  await seedMessages(email, conversationId, messages);
  return conversationId;
}

/** How far the thread's viewport is from its end, and how wide the thread is. */
function readThread(page: Page): Promise<{ fromEnd: number; width: number }> {
  return page.evaluate(() => {
    let scroller = document.getElementById('messages-end')?.parentElement ?? null;
    while (scroller != null && !['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    if (scroller == null) {
      throw new Error('The thread has no scroller');
    }
    return {
      fromEnd: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      width: scroller.clientWidth,
    };
  });
}

test.describe('thread end across a width change', () => {
  let conversationId: string | undefined;

  test.afterEach(async () => {
    if (conversationId == null) {
      return;
    }
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
    conversationId = undefined;
  });

  test('a reader at the end stays there when a panel narrows the thread, and one further up is left alone @scenario:thread-end-kept-across-width-change', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    conversationId = await seedLongChat();
    await page.goto(`/c/${conversationId}`);
    await expect(page.getByText('Question 15', { exact: true })).toBeVisible();
    await expect.poll(async () => (await readThread(page)).fromEnd).toBeLessThanOrEqual(2);
    const wide = await readThread(page);

    /** The session rail takes a column of its own, so the thread narrows and re-wraps. */
    const toggle = page.getByTestId('header-background-tasks-button');
    const rail = page.getByRole('complementary', { name: 'Session' });
    /** The thread's own control, not the navigation rail's end marker, which shares its name. */
    const scrollToEnd = page
      .getByRole('button', { name: 'Scroll to bottom' })
      .and(page.locator(':not([data-msg-id])'));
    await toggle.click();
    await expect(rail).toBeVisible();
    await expect.poll(async () => (await readThread(page)).width).toBeLessThan(wide.width);
    expect((await readThread(page)).fromEnd).toBeLessThanOrEqual(2);
    /** Long enough for the control to have shown itself, had the end moved away. */
    await page.waitForTimeout(600);
    expect((await readThread(page)).fromEnd).toBeLessThanOrEqual(2);
    await expect(scrollToEnd).toHaveCount(0);

    await toggle.click();
    await expect(rail).toHaveCount(0);
    await expect.poll(async () => (await readThread(page)).fromEnd).toBeLessThanOrEqual(2);

    /** A reader who went up the thread is reading something there: they are not taken away. */
    await page.getByText('Question 15', { exact: true }).hover();
    await page.mouse.wheel(0, -1500);
    await expect.poll(async () => (await readThread(page)).fromEnd).toBeGreaterThan(1000);
    await toggle.click();
    await expect(rail).toBeVisible();
    await page.waitForTimeout(600);
    expect((await readThread(page)).fromEnd).toBeGreaterThan(1000);
  });
});
