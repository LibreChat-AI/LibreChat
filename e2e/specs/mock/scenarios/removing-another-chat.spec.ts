import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Request, Response } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  replyText,
  uniqueName,
  replyPrompt,
  requestJson,
  messagesView,
  NEW_CHAT_PATH,
  isAgentsStream,
  MOCK_ENDPOINTS,
  sendMessage,
  getAccessToken,
  isAssistantsStop,
  selectMockEndpoint,
  uploadViaUnifiedButton,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { deleteConversations, seedConversations, withMongo } from '../db';
import { openChatHistory, openConversationMenu } from './sidebar';
import { closeMobileDrawer } from '../agents.helpers';
import { getE2EUser } from '../../../setup/user';

/**
 * Deleting or archiving a chat replaces the open one only when it is the chat that went away.
 * The router keeps reading `/c/new` after a new chat's first turn (the address is renamed past
 * it), so "the open chat" is the route's id, or the chat's own id while the route says `new`.
 * An unsent chat has no id of its own, so removing any saved chat leaves it and its composer
 * alone. A new chat that replaces a removed one shows nothing of the removed chat's turn, even
 * while that turn was still streaming into the new chat's messages.
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

/**
 * Lands a removal inside the window where the removed chat's reply can still write the new chat:
 * the removal's response is held until the reply's next chunk arrives and handed over ahead of
 * it, and the chunk, with any frame it asks for, is read once the removal's own cache update has
 * run. Without it that window is a few milliseconds wide and the race shows only now and then.
 * Install before the page loads; the returned call arms it for the next archive or delete.
 */
async function holdRemovalForNextChunk(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    const hold: { armed: boolean; release: (() => void) | null } = { armed: false, release: null };
    Object.assign(window, { __removalHold: hold });
    const xhr = XMLHttpRequest.prototype;
    const { open, send, addEventListener } = xhr;
    const routes = new WeakMap<XMLHttpRequest, string>();
    xhr.open = function (this: XMLHttpRequest, ...args: Parameters<typeof open>) {
      const [method, url] = args;
      routes.set(this, `${method.toUpperCase()} ${new URL(String(url), location.href).pathname}`);
      return open.apply(this, args);
    } as typeof xhr.open;
    xhr.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const route = routes.get(this);
      if (hold.armed && (route === 'POST /api/convos/archive' || route === 'DELETE /api/convos')) {
        hold.armed = false;
        const done = this.onloadend;
        this.onloadend = (event) => {
          const release = () => {
            if (hold.release === release) {
              hold.release = null;
              done?.call(this, event);
            }
          };
          hold.release = release;
          setTimeout(release, 5000);
        };
      }
      return send.call(this, body);
    };
    /** Frames a held-back chunk asks for run as soon as it has been read. */
    let frames: FrameRequestCallback[] | null = null;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      if (frames == null) {
        return requestFrame(callback);
      }
      frames.push(callback);
      return 0;
    };
    xhr.addEventListener = function (
      this: XMLHttpRequest,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type !== 'progress' || typeof listener !== 'function') {
        return addEventListener.call(this, type, listener, options);
      }
      return addEventListener.call(
        this,
        type,
        function (this: XMLHttpRequest, event: Event) {
          const release = hold.release;
          if (release == null) {
            listener.call(this, event);
            return;
          }
          release();
          setTimeout(() => {
            frames = [];
            try {
              listener.call(this, event);
            } finally {
              const requested = frames;
              frames = null;
              requested.forEach((callback) => callback(performance.now()));
            }
          });
        },
        options,
      );
    } as typeof xhr.addEventListener;
  });
  return async () => {
    await page.evaluate(() => {
      (window as unknown as { __removalHold: { armed: boolean } }).__removalHold.armed = true;
    });
  };
}

/** The new chat shows nothing of a removed chat's turn: neither its prompt nor any of its reply. */
async function expectNothingOf(page: Page, prompt: string, chunk: RegExp) {
  await expect(messagesView(page).getByText(prompt)).toHaveCount(0);
  await expect(messagesView(page).getByText(chunk)).toHaveCount(0);
}

const ASSISTANT_MODEL = 'gpt-4o-mini';

/**
 * Sends a new chat's first turn to a new assistant and returns once its reply is streaming. The
 * Assistants stream keeps the address at `/c/new`, so the chat's id is read from its saved prompt.
 * With `stopFails`, the fake Assistants API cannot read the run back, so stopping it fails.
 */
async function startSlowAssistantChat(page: Page, label: string, { stopFails = false } = {}) {
  const prompt = stopFails
    ? `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_STEPS_FAIL:${label}`
    : `E2E_ASSISTANT_SLOW:${label}`;
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const token = await getAccessToken(page);
  const assistant = await requestJson<{ id: string }>(page, {
    path: '/api/assistants/v2',
    token,
    method: 'POST',
    body: { endpoint: 'assistants', model: ASSISTANT_MODEL, name: `E2E ${label}` },
  });
  const removeAssistant = () =>
    requestJson(page, {
      path: `/api/assistants/v2/${encodeURIComponent(assistant.id)}?endpoint=assistants&model=${ASSISTANT_MODEL}`,
      token,
      method: 'DELETE',
      body: { endpoint: 'assistants' },
    });
  await page.goto(
    `/c/new?endpoint=assistants&model=${ASSISTANT_MODEL}&assistant_id=${encodeURIComponent(assistant.id)}`,
    { timeout: 15000 },
  );
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.fill(prompt);
  await expect(input).toHaveValue(prompt);
  await input.press('Enter');
  await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20000 });
  let conversationId = '';
  await expect
    .poll(async () => {
      conversationId = await withMongo(async (db) => {
        const saved = await db.collection('messages').findOne({ text: prompt });
        return typeof saved?.conversationId === 'string' ? saved.conversationId : '';
      });
      return conversationId;
    })
    .not.toBe('');
  return { conversationId, prompt, removeAssistant };
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
    const armHold = await holdRemovalForNextChunk(page);
    const label = await startSlowNewChat(page);
    const archivedId = openChatId(page);
    cleanup.push(archivedId);

    await armHold();
    await removeFromSidebar(page, rowOf(page, archivedId), 'Archive');

    /** Until the reply ends the address reads the chat's id, so `/c/new` is the replacement. */
    await expect(page).toHaveURL(/\/c\/new(\?|$)/);
    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('');
    /** The composer stops generating once the archived turn's stream is closed, after which
     *  nothing of that turn can reach the new chat. */
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    await expectNothingOf(page, `E2E_SLOW_REPLY:${label}`, /chunk-\d{3}/);
  });

  test('deleting a new chat while it streams its first reply opens a new chat @scenario:deleting-a-streaming-new-chat-opens-a-new-chat', async ({
    page,
  }) => {
    test.setTimeout(120000);
    /** The server stops the reply before it answers the delete; held, that stop lands after. */
    const armHold = await holdRemovalForNextChunk(page);
    const label = await startSlowNewChat(page);
    const deletedId = openChatId(page);
    cleanup.push(deletedId);

    await armHold();
    await removeFromSidebar(page, rowOf(page, deletedId), 'Delete');

    await expect(page).toHaveURL(/\/c\/new(\?|$)/);
    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    await expectNothingOf(page, `E2E_SLOW_REPLY:${label}`, /chunk-\d{3}/);
  });

  test('archiving an assistant chat while it streams its first reply opens a new chat @scenario:archiving-a-streaming-assistant-chat-opens-a-new-chat', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const armHold = await holdRemovalForNextChunk(page);
    const label = uniqueName('assistant-archive');
    const { conversationId, prompt, removeAssistant } = await startSlowAssistantChat(page, label);
    cleanup.push(conversationId);
    try {
      await armHold();
      const stopped = page.waitForResponse(isAssistantsStop, { timeout: 30000 });
      await removeFromSidebar(page, rowOf(page, conversationId), 'Archive');

      /** Leaving the stream asks the server to stop the run; the composer is ready once it has. */
      expect((await stopped).status()).toBe(200);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
      await expect(page.getByTestId('send-button')).toBeVisible();
      await expect(page).toHaveURL(/\/c\/new(\?|$)/);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
      await expectNothingOf(page, prompt, /achunk-\d{3}/);
    } finally {
      await removeAssistant();
    }
  });

  test('archiving an assistant chat whose stop fails on the server still opens a new chat @scenario:archiving-an-assistant-chat-whose-stop-fails-opens-a-new-chat', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueName('assistant-stop-fails');
    const { conversationId, prompt, removeAssistant } = await startSlowAssistantChat(page, label, {
      stopFails: true,
    });
    cleanup.push(conversationId);
    try {
      const stopped = page.waitForResponse(isAssistantsStop, { timeout: 30000 });
      await removeFromSidebar(page, rowOf(page, conversationId), 'Archive');

      /** The run is cancelled but cannot be read back, and the stop answers with an error. Once
       *  that answer lands the composer is ready, and the pane stays on the new chat. */
      expect((await stopped).status()).toBe(500);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
      await expect(page.getByTestId('send-button')).toBeVisible();
      await expect(page).toHaveURL(/\/c\/new(\?|$)/);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveValue('');
      await expectNothingOf(page, prompt, /achunk-\d{3}/);
    } finally {
      await removeAssistant();
    }
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
