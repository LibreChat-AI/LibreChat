import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  conversationRow,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openChatHistory } from './sidebar';
import { withMongo } from '../db';

/**
 * A conversation opened beside the one on screen, from its row in the sidebar: the reader keeps
 * the chat they are in and takes a turn in the other.
 */
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function startChat(page: Page, label: string): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible();
  return page.url();
}

test('an earlier conversation opens beside the one on screen and takes a turn there @scenario:side-chat-opens-conversation-beside', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const earlier = uniqueLabel('earlier');
  const current = uniqueLabel('current');
  const followUp = uniqueLabel('beside');

  const earlierUrl = await startChat(page, earlier);
  const currentUrl = await startChat(page, current);
  const currentPath = new URL(currentUrl).pathname;
  expect(currentPath).not.toBe(new URL(earlierUrl).pathname);

  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();

  /** The earlier conversation is beside the current one, which has not moved. */
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toBeVisible({ timeout: 30_000 });
  await expect(sideChat).toContainText(replyText(earlier));
  await expect(sideChat).not.toContainText(replyText(current));
  expect(new URL(page.url()).pathname).toBe(currentPath);
  await expect(messagesView(page).getByText(replyText(current))).toBeVisible();

  /** A turn from its composer runs in that conversation, not the one on screen. */
  const composer = sideChat.getByRole('textbox', { name: 'Message input' });
  await composer.fill(replyPrompt(followUp));
  const [start] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/api\/agents\/chat\/[^/]+$/.test(new URL(request.url()).pathname) &&
        !request.url().endsWith('/abort'),
    ),
    composer.press('Enter'),
  ]);
  const posted = start.postDataJSON() as { conversationId?: string };
  expect(earlierUrl).toContain(posted.conversationId ?? 'none');
  await expect(sideChat).toContainText(replyText(followUp), { timeout: 30_000 });
  await expect(messagesView(page).getByText(replyText(followUp))).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(currentPath);

  /** The chat on screen cannot be opened beside itself. */
  const currentRow = conversationRow(page, currentUrl);
  await currentRow.hover();
  await currentRow.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open beside chat' })).toHaveCount(0);
});

test('a turn in a side chat shows its message once while the reply streams @scenario:side-chat-turn-shows-one-message', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const earlier = uniqueLabel('earlier-run');
  const slow = uniqueLabel('slow');

  const earlierUrl = await startChat(page, earlier);
  await startChat(page, uniqueLabel('current-run'));
  const besideId = new URL(earlierUrl).pathname.split('/').pop() ?? '';

  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toContainText(replyText(earlier), { timeout: 30_000 });

  /** Reads of the side conversation's stored messages from here on. */
  const reads: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'GET' && pathname === `/api/messages/${besideId}`) {
      reads.push(pathname);
    }
  });

  const composer = sideChat.getByRole('textbox', { name: 'Message input' });
  await composer.click();
  await page.keyboard.type(`E2E_SLOW_REPLY:${slow}`);
  await page.keyboard.press('Enter');

  /**
   * The server stores the message under an id of its own. While the reply streams, the message
   * the reader sent is still the one row for it: no second copy to switch between, and the
   * reply filling under it is the one drawn for the conversation's model.
   */
  await expect(sideChat).toContainText('chunk-005', { timeout: 30_000 });
  const turns = sideChat.locator('.message-render');
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(2)).toContainText(`E2E_SLOW_REPLY:${slow}`);
  await expect(turns.nth(2)).not.toContainText(/\d+\s*\/\s*\d+/);
  await expect(turns.nth(3)).toContainText(MOCK_ENDPOINTS[0].label);

  /** Its own final frame is the turn's result: the conversation is not read back over it. */
  await expect(sideChat).toContainText('chunk-159', { timeout: 90_000 });
  await expect(sideChat.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(2)).not.toContainText(/\d+\s*\/\s*\d+/);
  expect(reads).toEqual([]);
});

const isSeenReport = (request: Request, conversationId: string): boolean =>
  request.method() === 'POST' &&
  new URL(request.url()).pathname === '/api/convos/seen' &&
  (request.postData() ?? '').includes(conversationId);

test('a reply read in a side chat is acknowledged @scenario:side-chat-reply-is-marked-seen', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const earlier = uniqueLabel('earlier-seen');
  const followUp = uniqueLabel('read-beside');
  const earlierUrl = await startChat(page, earlier);
  const besideId = new URL(earlierUrl).pathname.split('/').pop() ?? '';
  await startChat(page, uniqueLabel('current-seen'));

  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toContainText(replyText(earlier), { timeout: 30_000 });

  /** The reply lands in front of the reader, so the server is told they have seen it. */
  const composer = sideChat.getByRole('textbox', { name: 'Message input' });
  await composer.click();
  await page.keyboard.type(replyPrompt(followUp));
  const [seen] = await Promise.all([
    page.waitForRequest((request) => isSeenReport(request, besideId), { timeout: 30_000 }),
    page.keyboard.press('Enter'),
  ]);
  await expect(sideChat).toContainText(replyText(followUp));
  expect((await seen.response())?.ok()).toBeTruthy();
  await expect(row.getByRole('button').first()).not.toHaveAccessibleName(/Unread/);
});

test('a reply in a side chat is read out when it ends @scenario:side-chat-reply-is-announced', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const earlier = uniqueLabel('earlier-said');
  const followUp = uniqueLabel('said-beside');
  const earlierUrl = await startChat(page, earlier);
  await startChat(page, uniqueLabel('current-said'));

  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toContainText(replyText(earlier), { timeout: 30_000 });

  const composer = sideChat.getByRole('textbox', { name: 'Message input' });
  await composer.click();
  await page.keyboard.type(replyPrompt(followUp));
  await page.keyboard.press('Enter');
  await expect(sideChat).toContainText(replyText(followUp), { timeout: 30_000 });

  /** The page's polite live region, which is how a screen reader hears main chat's replies. */
  const spoken = page.locator('.sr-only > [aria-live="polite"]');
  await expect(spoken.filter({ hasText: replyText(followUp) })).toHaveCount(1);
});

test('an unread conversation opened beside the chat is caught up with @scenario:side-chat-catches-up-an-unread-conversation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const earlier = uniqueLabel('earlier-unread');
  const earlierUrl = await startChat(page, earlier);
  const besideId = new URL(earlierUrl).pathname.split('/').pop() ?? '';
  await startChat(page, uniqueLabel('current-unread'));

  /** As if its reply had landed while the reader was away: last seen before it. */
  await withMongo(async (db) => {
    const updated = await db
      .collection('conversations')
      .updateOne({ conversationId: besideId }, { $set: { lastSeenAt: new Date(0) } });
    expect(updated.matchedCount).toBe(1);
  });
  await page.reload();
  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  const link = row.getByRole('button').first();
  await expect(link).toHaveAccessibleName(/Unread/);

  /** Reading it beside the chat is reading it: the reply is acknowledged and the dot goes. */
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  const [seen] = await Promise.all([
    page.waitForRequest((request) => isSeenReport(request, besideId), { timeout: 30_000 }),
    page.getByRole('menuitem', { name: 'Open beside chat' }).click(),
  ]);
  await expect(page.getByRole('region', { name: 'Side chat' })).toContainText(replyText(earlier));
  expect((await seen.response())?.ok()).toBeTruthy();
  await expect(link).not.toHaveAccessibleName(/Unread/);
});

test.describe('on a small screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the sidebar drawer gets out of the way and the conversation opens over the chat @scenario:side-chat-opens-beside-on-a-small-screen', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const earlier = uniqueLabel('earlier-small');
    const current = uniqueLabel('current-small');

    const earlierUrl = await startChat(page, earlier);
    await startChat(page, current);

    await openChatHistory(page);
    const row = conversationRow(page, earlierUrl);
    await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
    await page.getByRole('menuitem', { name: 'Open beside chat' }).click();

    /** There is no room beside the chat here: the conversation opens as a sheet over it. */
    const sideChat = page.getByRole('dialog', { name: 'Side chat' });
    await expect(sideChat).toBeVisible({ timeout: 30_000 });
    await expect(sideChat).toContainText(replyText(earlier));
    /**
     * Not behind the drawer: its rows are out of the way, and the composer takes a tap and what
     * is typed after it. The tap waits out the drawer's slide, during which the chat behind it
     * takes no input, as a reader's would.
     */
    await expect(row).not.toBeInViewport();
    const composer = sideChat.getByRole('textbox', { name: 'Message input' });
    await composer.click();
    await page.keyboard.type('Still reachable');
    await expect(composer).toHaveValue('Still reachable');
  });
});

test('a saved conversation beside a temporary chat keeps its turns @scenario:side-chat-turn-is-not-temporary-beside-a-temporary-chat', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const saved = uniqueLabel('saved');
  const followUp = uniqueLabel('kept');
  const savedUrl = await startChat(page, saved);

  /** The chat on screen is a new one the reader has made temporary. */
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const temporary = page.getByRole('button', { name: 'Temporary Chat' });
  await temporary.click();
  await expect(temporary).toHaveAttribute('aria-pressed', 'true');

  await openChatHistory(page);
  const row = conversationRow(page, savedUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toContainText(replyText(saved), { timeout: 30_000 });

  /** Temporary is what the chat on screen is, not the saved conversation beside it. */
  const composer = sideChat.getByRole('textbox', { name: 'Message input' });
  await composer.click();
  await page.keyboard.type(replyPrompt(followUp));
  const [start] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        /\/api\/agents\/chat\/[^/]+$/.test(new URL(request.url()).pathname) &&
        !request.url().endsWith('/abort'),
    ),
    page.keyboard.press('Enter'),
  ]);
  const posted = start.postDataJSON() as { conversationId?: string; isTemporary?: boolean };
  expect(savedUrl).toContain(posted.conversationId ?? 'none');
  expect(posted.isTemporary).toBe(false);
  await expect(sideChat).toContainText(replyText(followUp), { timeout: 30_000 });
});
