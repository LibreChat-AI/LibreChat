import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Request, Response } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  replyText,
  uniqueName,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  isAgentsStream,
  MOCK_ENDPOINTS,
  sendMessage,
  selectMockEndpoint,
  uploadViaUnifiedButton,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openChatHistory, openConversationMenu } from './sidebar';
import { deleteConversations, seedConversations } from '../db';
import { closeMobileDrawer } from '../agents.helpers';
import { getE2EUser } from '../../../setup/user';

/**
 * Deleting or archiving a chat replaces the open one only when it is the chat that went away.
 * The router keeps reading `/c/new` after a new chat's first turn (the address is renamed past
 * it), so "the open chat" is the route's id, or the chat's own id while the route says `new`.
 * An unsent chat has no id of its own, so removing any saved chat leaves it and its composer
 * alone.
 */

const isConvoRequest = (method: string, path: string) => (response: Response) =>
  response.request().method() === method && new URL(response.url()).pathname === path;

const isFileDeletion = (request: Request) =>
  request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/files';

/** A saved chat the scenario removes from the sidebar, other than the one on screen. */
async function seedOtherChat(): Promise<{ conversationId: string; title: string }> {
  const other = { conversationId: randomUUID(), title: uniqueName('Other chat') };
  await seedConversations(getE2EUser().email, [{ ...other, updatedAt: new Date() }]);
  return other;
}

const rowOf = (page: Page, conversationId: string) =>
  page
    .getByTestId('convo-item')
    .and(page.locator(`[data-conversation-id="${conversationId}"]`))
    .first();

/**
 * Sends a new chat's first turn and returns once its reply is streaming. The router keeps
 * reading `/c/new` until that reply ends, while the address and the chat carry the new id.
 */
async function startSlowNewChat(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const label = uniqueName('streaming');
  const run = await sendMessage(page, `E2E_SLOW_REPLY:${label}`);
  expect(run.ok()).toBe(true);
  await expect(messagesView(page).getByText(/chunk-010/)).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}(\?|$)/);
  return label;
}

/** Deletes or archives a chat from its sidebar row and waits for the change to land. */
async function removeFromSidebar(page: Page, row: Locator, action: 'Delete' | 'Archive') {
  await openChatHistory(page);
  await expect(row).toBeVisible({ timeout: 20000 });
  await openConversationMenu(row);
  const item = page.getByRole('menuitem', { name: action, exact: true });
  if (action === 'Archive') {
    const [archived] = await Promise.all([
      page.waitForResponse(isConvoRequest('POST', '/api/convos/archive'), { timeout: 30000 }),
      item.click(),
    ]);
    expect(archived.ok()).toBe(true);
    /** Announced by the same callback that would replace the open chat. */
    await expect(page.getByText('Conversation archived', { exact: true }).first()).toBeAttached();
  } else {
    await item.click();
    const dialog = page.getByRole('dialog', { name: 'Delete chat?' });
    const [deleted] = await Promise.all([
      page.waitForResponse(isConvoRequest('DELETE', '/api/convos'), { timeout: 30000 }),
      dialog.getByRole('button', { name: 'Delete', exact: true }).click(),
    ]);
    expect(deleted.ok()).toBe(true);
    await expect(dialog).toBeHidden();
  }
  await expect(row).toHaveCount(0);
  await closeMobileDrawer(page);
  /** On a small screen the chat pane stays inert until the drawer has slid away. */
  await expect(page.getByTestId('app-pane')).not.toHaveAttribute('inert');
}

/** Opens an unsent chat and attaches a file to it; resolves to the attachment's chip and id. */
async function attachToUnsentChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  return attachFile(page);
}

async function attachFile(page: Page) {
  const fileName = `${uniqueName('unsent')}.md`;
  const upload = await uploadViaUnifiedButton(page, {
    name: fileName,
    mimeType: 'text/markdown',
    content: '# Attached to the unsent chat\n',
  });
  expect(upload.ok()).toBe(true);
  const { file_id: fileId } = (await upload.json()) as UploadedFile;
  expect(fileId).toBeTruthy();
  const chip = page
    .getByTestId('composer-tray')
    .getByRole('button', { name: fileName, exact: true });
  await expect(chip).toBeVisible({ timeout: 15000 });
  return { chip, fileId };
}

/** Sends the unsent chat and returns the file ids its request carried. */
async function sendUnsentChat(page: Page, label: string): Promise<string[]> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill(replyPrompt(label));
  await expect(input).toHaveValue(replyPrompt(label));
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
  );
  const [stream] = await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30000 }),
    page.getByTestId('send-button').click(),
  ]);
  expect(stream.ok()).toBe(true);
  const payload = (await sent).postDataJSON() as { files?: Array<{ file_id?: string }> };
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 20000 });
  return (payload.files ?? []).map((file) => file.file_id ?? '');
}

/** The id the address bar shows for the chat on screen. */
const openChatId = (page: Page) => new URL(page.url()).pathname.split('/c/')[1];

test.describe('removing another chat', () => {
  const cleanup: string[] = [];

  test.afterEach(async () => {
    await deleteConversations(cleanup.splice(0));
  });

  test('deleting another chat keeps the unsent chat and its attachment @scenario:deleting-another-chat-keeps-the-unsent-chats-attachment', async ({
    page,
  }) => {
    test.setTimeout(120000);
    /** Without saved drafts a reset also deletes the stored upload, the loss the user feels. */
    await page.addInitScript(() => localStorage.setItem('saveDrafts', 'false'));
    const other = await seedOtherChat();
    cleanup.push(other.conversationId);
    const deletions: string[] = [];
    page.on('request', (request) => {
      if (isFileDeletion(request)) {
        deletions.push(request.url());
      }
    });

    const { chip, fileId } = await attachToUnsentChat(page);
    await removeFromSidebar(page, rowOf(page, other.conversationId), 'Delete');

    await expect(page).toHaveURL(/\/c\/new(\?|$)/);
    await expect(chip).toBeVisible();
    const label = uniqueName('after-delete');
    expect(await sendUnsentChat(page, label)).toEqual([fileId]);
    cleanup.push(openChatId(page));
    expect(deletions).toEqual([]);
  });

  test('archiving another chat keeps the unsent chat and its attachment @scenario:archiving-another-chat-keeps-the-unsent-chats-attachment', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const other = await seedOtherChat();
    cleanup.push(other.conversationId);
    const deletions: string[] = [];
    page.on('request', (request) => {
      if (isFileDeletion(request)) {
        deletions.push(request.url());
      }
    });

    const { chip, fileId } = await attachToUnsentChat(page);
    await removeFromSidebar(page, rowOf(page, other.conversationId), 'Archive');

    await expect(page).toHaveURL(/\/c\/new(\?|$)/);
    await expect(chip).toBeVisible();
    const label = uniqueName('after-archive');
    expect(await sendUnsentChat(page, label)).toEqual([fileId]);
    cleanup.push(openChatId(page));
    expect(deletions).toEqual([]);
  });

  test('deleting another chat while a new chat streams its first reply keeps that chat open @scenario:deleting-another-chat-keeps-a-streaming-new-chat-open', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const other = await seedOtherChat();
    cleanup.push(other.conversationId);
    const label = await startSlowNewChat(page);
    const startedId = openChatId(page);
    cleanup.push(startedId);
    /** The reply's end moves the router onto the address and drops its query, so only the id is compared. */
    const started = new RegExp(`/c/${startedId}(\\?|$)`);

    await removeFromSidebar(page, rowOf(page, other.conversationId), 'Delete');

    await expect(page).toHaveURL(started);
    await expect(messagesView(page).getByText(`E2E_SLOW_REPLY:${label}`)).toBeVisible();
    await expect(messagesView(page).getByText(/chunk-159/)).toBeVisible({ timeout: 60000 });
    await expect(page).toHaveURL(started);
  });

  test('archiving a new chat while it streams its first reply opens a new chat @scenario:archiving-a-streaming-new-chat-opens-a-new-chat', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await startSlowNewChat(page);
    const archivedId = openChatId(page);
    cleanup.push(archivedId);

    await removeFromSidebar(page, rowOf(page, archivedId), 'Archive');

    /** Until the reply ends the address reads the chat's id, so `/c/new` is the replacement.
     *  Whether the cut-off reply is cleared from the new chat's view is a separate reset race
     *  that predates this rule, so it is not asserted here. */
    await expect(page).toHaveURL(/\/c\/new(\?|$)/);
    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('');
  });

  test('a new chat opened while the last one is being archived keeps its attachment @scenario:a-chat-opened-while-an-archive-lands-keeps-its-attachment', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.addInitScript(() => localStorage.setItem('saveDrafts', 'false'));
    const deletions: string[] = [];
    page.on('request', (request) => {
      if (isFileDeletion(request)) {
        deletions.push(request.url());
      }
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const label = uniqueName('archived-later');
    expect((await sendMessageAndWaitForCompletion(page, replyPrompt(label))).ok()).toBe(true);
    cleanup.push(openChatId(page));

    /** The archive is held until a new chat is open with a file attached, so it lands there. */
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/convos/archive', async (route) => {
      await held;
      await route.continue();
    });
    const archived = page.waitForResponse(isConvoRequest('POST', '/api/convos/archive'), {
      timeout: 60000,
    });
    /** The header's chat actions sit behind "Chat options" on a wide screen and the overflow
     *  menu on a small one; both are the same `useChatOptions` items. */
    const narrow = (page.viewportSize()?.width ?? 1280) <= 768;
    await (
      narrow
        ? page.getByTestId('header-overflow-menu')
        : page.getByRole('button', { name: 'Chat options', exact: true })
    ).click();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await page
      .getByRole('link', { name: 'New chat', exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/c\/new(\?|$)/);
    await expect(messagesView(page).getByText(replyText(label))).toHaveCount(0);
    const { chip } = await attachFile(page);

    release();
    expect((await archived).ok()).toBe(true);
    await expect(page.getByText('Conversation archived', { exact: true }).first()).toBeAttached();

    await expect(page).toHaveURL(/\/c\/new(\?|$)/);
    await expect(chip).toBeVisible();
    expect(deletions).toEqual([]);
  });
});
