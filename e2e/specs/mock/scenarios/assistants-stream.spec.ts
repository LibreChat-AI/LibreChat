import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  replyPrompt,
  messagesView,
  requestJson,
  getAccessToken,
  isAssistantsStop,
} from '../helpers';
import { openChatHistory, openSidebar } from './sidebar';
import { withMongo } from '../db';

type CreatedAssistant = { id: string };

const MODEL = 'gpt-4o-mini';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function createAssistant(
  page: Page,
  name: string,
  version: 'v1' | 'v2' = 'v2',
): Promise<CreatedAssistant> {
  await page.goto('/c/new', { timeout: 10000 });
  const token = await getAccessToken(page);
  return requestJson<CreatedAssistant>(page, {
    path: `/api/assistants/${version}`,
    token,
    method: 'POST',
    body: { endpoint: 'assistants', model: MODEL, name },
  });
}

async function deleteAssistant(page: Page, assistantId: string, version: 'v1' | 'v2' = 'v2') {
  const token = await getAccessToken(page);
  await requestJson(page, {
    path: `/api/assistants/${version}/${encodeURIComponent(assistantId)}?endpoint=assistants&model=${MODEL}`,
    token,
    method: 'DELETE',
    body: { endpoint: 'assistants' },
  });
}

/** Opens a new chat with the assistant selected and sends `text` through the Assistants stream. */
async function sendToAssistant(page: Page, assistantId: string, text: string) {
  await page.goto(
    `/c/new?endpoint=assistants&model=${MODEL}&assistant_id=${encodeURIComponent(assistantId)}`,
    { timeout: 15000 },
  );
  await send(page, text);
}

/** Sends `text` from the open chat's composer through the Assistants stream. */
async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  await input.fill(text);
  await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname.startsWith('/api/assistants/v2/chat'),
      { timeout: 30000 },
    ),
    input.press('Enter'),
  ]);
}

/** Leaves the open chat for a new one from the sidebar: the rail on desktop, the drawer on mobile. */
async function startNewChat(page: Page) {
  await openSidebar(page);
  await page
    .getByRole('link', { name: 'New chat', exact: true })
    .filter({ visible: true })
    .first()
    .click();
}

/** Leaves the open chat for a saved one, picked from the conversation list. */
async function openSavedChat(page: Page, conversationId: string) {
  await openChatHistory(page);
  await page
    .getByTestId('convo-item')
    .and(page.locator(`[data-conversation-id="${conversationId}"]`))
    .filter({ visible: true })
    .first()
    .click();
}

type StoredMessage = { isCreatedByUser?: boolean; content?: { type: string }[] };

/** The kinds of content each saved reply of the open chat holds, oldest reply first. */
async function savedReplyParts(page: Page): Promise<string[][]> {
  const conversationId = new URL(page.url()).pathname.split('/').pop() ?? '';
  const token = await getAccessToken(page);
  const messages = await requestJson<StoredMessage[]>(page, {
    path: `/api/messages/${encodeURIComponent(conversationId)}`,
    token,
  });
  return messages
    .filter((message) => message.isCreatedByUser !== true)
    .map((message) => (message.content ?? []).map((part) => part.type));
}

/** Stops the streaming run from the composer and resolves with the stop's status. */
async function stopRun(page: Page): Promise<number> {
  const [stopped] = await Promise.all([
    page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
    page.getByRole('button', { name: 'Stop generating' }).click(),
  ]);
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 20_000,
  });
  return stopped.status();
}

const PROVIDER = `http://127.0.0.1:${process.env.E2E_ASSISTANTS_PORT || '8890'}`;

type ProviderRequest = { method: string; path: string; body?: { assistant_id?: string } };

/** How many runs the app started for `assistantId`, and how often it read back (and billed)
 *  each run it read: once by the stop, or once by the request that recovers a failed run. */
async function runReads(page: Page, assistantId: string) {
  const response = await page.request.get(`${PROVIDER}/__e2e/requests`);
  const { requests } = (await response.json()) as { requests: ProviderRequest[] };
  const threads = new Set<string>();
  let runs = 0;
  for (const { method, path, body } of requests) {
    const thread = path.match(/^\/v1\/threads\/([^/]+)\/runs$/)?.[1];
    if (method === 'POST' && thread && body?.assistant_id === assistantId) {
      threads.add(thread);
      runs += 1;
    }
  }
  const reads = new Map<string, number>();
  for (const { method, path } of requests) {
    const [, thread, run] = path.match(/^\/v1\/threads\/([^/]+)\/runs\/([^/]+)$/) ?? [];
    if (method === 'GET' && run && threads.has(thread)) {
      reads.set(run, (reads.get(run) ?? 0) + 1);
    }
  }
  return { runs, reads: [...reads.values()] };
}

/** Sends `text` to an assistant through a chat route the way an API client does, and drops the
 *  connection once the stream carries `until`. Resolves with the conversation the turn created. */
async function sendAndDrop(
  page: Page,
  {
    version,
    assistantId,
    text,
    until,
  }: { version: 'v1' | 'v2'; assistantId: string; text: string; until: string },
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(new URL(`/api/assistants/${version}/chat`, page.url()), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getAccessToken(page)}`,
      'Content-Type': 'application/json',
      /** The chat routes refuse a client that does not identify as a browser. */
      'User-Agent': await page.evaluate(() => navigator.userAgent),
    },
    body: JSON.stringify({
      text,
      sender: 'User',
      endpoint: 'assistants',
      model: MODEL,
      assistant_id: assistantId,
      messageId: randomUUID(),
      parentMessageId: NO_PARENT,
      conversationId: null,
      isCreatedByUser: true,
      clientTimestamp: new Date().toISOString(),
    }),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let transcript = '';
  try {
    while (!transcript.includes(until)) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      transcript += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  return /"conversationId":"([0-9a-f-]{36})"/.exec(transcript)?.[1] ?? '';
}

/** How many transactions billing wrote for the conversation: two (prompt, completion) per read. */
const billedFor = (conversationId: string) =>
  withMongo((db) => db.collection('transactions').countDocuments({ conversationId }));

/** A request that closes before its run settles checks the run's stop marker 2 s later, then
 *  recovers the run if nothing else did; counting waits past that check and its read. */
const RECOVERY_CHECK_MS = 6_000;

/** A run that writes a whole message (`apart-one`), calls a tool, then streams a second one. */
const PARTS = 'E2E_ASSISTANT_SLOW:E2E_ASSISTANT_PARTS';
const RUN_PARTS = ['text', 'tool_call', 'text'];

/** How the stop route refuses a run whose account is being deleted (`withAssistantRun`). */
const ACCOUNT_DELETION_REFUSAL = {
  status: 409,
  json: { message: 'Account deletion is in progress', code: 'ACCOUNT_DELETION_IN_PROGRESS' },
};
const STOP_FAILURE = /Unexpected response from server; Status: 409/;
const CRASH = /Cannot read properties/;

/** Assistants turns carry their own response and stream through the legacy (non-resumable)
 *  path; these follow a send, a stop and a failed run on the running app. */
test.describe('assistants stream', () => {
  test('an assistant reply streams in and the chat moves to its saved route @scenario:assistants-send-streams-reply', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const label = uniqueLabel('assistant-send');
    const assistant = await createAssistant(page, `E2E stream ${label}`);
    try {
      await sendToAssistant(page, assistant.id, replyPrompt(label));
      await expect(messagesView(page).getByText(`E2E assistant reply ${label}`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);

      await page.reload();
      await expect(messagesView(page).getByText(replyPrompt(label))).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('stopping an assistant run keeps what streamed and re-enables sending @scenario:assistants-stop-keeps-streamed-text', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-stop');
    const assistant = await createAssistant(page, `E2E stop ${label}`);
    try {
      await sendToAssistant(page, assistant.id, `E2E_ASSISTANT_SLOW:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });

      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
        page.getByRole('button', { name: 'Stop generating' }).click(),
      ]);
      expect(stopped.status()).toBe(200);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 20_000,
      });
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible();
      await expect(messagesView(page).getByText(/achunk-120/)).toHaveCount(0);
      const input = page.getByRole('textbox', { name: 'Message input' });
      await expect(input).toBeEnabled();
      /** Sending is possible again once the stop has settled the run. */
      await input.fill(replyPrompt(label));
      await expect(page.getByTestId('send-button')).toBeEnabled();
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a stop that fails on the server keeps the chat open and re-enables sending @scenario:assistants-failed-stop-re-enables-sending', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-stop-fails');
    const prompt = `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_STEPS_FAIL:${label}`;
    const assistant = await createAssistant(page, `E2E stop fails ${label}`);
    try {
      /** The fake Assistants API cancels this run but cannot read it back, so the stop fails. */
      await sendToAssistant(page, assistant.id, prompt);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });

      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
        page.getByRole('button', { name: 'Stop generating' }).click(),
      ]);
      expect(stopped.status()).toBe(500);
      /** The chat reloads at its own address from what the server kept, ready for the next turn. */
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      await expect(messagesView(page).getByText(prompt)).toBeVisible();
      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill(replyPrompt(label));
      await expect(page.getByTestId('send-button')).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a stop that fails after cancelling keeps the reply that streamed @scenario:assistants-failed-stop-keeps-streamed-reply', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-stop-keeps');
    const prompt = `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_STEPS_FAIL:${label}`;
    const assistant = await createAssistant(page, `E2E stop keeps ${label}`);
    try {
      await sendToAssistant(page, assistant.id, prompt);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });

      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
        page.getByRole('button', { name: 'Stop generating' }).click(),
      ]);
      expect(stopped.status()).toBe(500);
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });

      /** The stop could not read the run back, so what the chat keeps is the reply as it streamed. */
      await page.reload();
      await expect(messagesView(page).getByText(prompt)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible();
      await expect(messagesView(page).getByText(/achunk-001/)).toHaveCount(1);
      await expect(messagesView(page).getByText(/achunk-120/)).toHaveCount(0);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a stop that succeeds leaves one reply after a reload @scenario:assistants-stop-saves-one-reply', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-stop-one');
    const assistant = await createAssistant(page, `E2E stop one ${label}`);
    try {
      await sendToAssistant(page, assistant.id, `E2E_ASSISTANT_SLOW:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });

      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
        page.getByRole('button', { name: 'Stop generating' }).click(),
      ]);
      expect(stopped.status()).toBe(200);
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });

      /** The run saved what it streamed and the stop saved the provider's copy: one reply. */
      await page.reload();
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/achunk-001/)).toHaveCount(1);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a reply a failed stop kept stays in place when the next turn is stopped @scenario:assistants-kept-reply-stays-after-next-stop', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('assistant-kept-next');
    const first = `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_STEPS_FAIL:${label}`;
    const second = `E2E_ASSISTANT_SLOW:second-${label}`;
    const assistant = await createAssistant(page, `E2E kept next ${label}`);
    const stop = async () => {
      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
        page.getByRole('button', { name: 'Stop generating' }).click(),
      ]);
      return stopped.status();
    };
    try {
      await sendToAssistant(page, assistant.id, first);
      await expect(messagesView(page).getByText(/achunk-004/)).toBeVisible({ timeout: 20_000 });
      expect(await stop()).toBe(500);
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      await page.reload();
      await expect(messagesView(page).getByText(/achunk-004/)).toBeVisible({ timeout: 20_000 });

      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill(second);
      await input.press('Enter');
      await expect(messagesView(page).getByText(second)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/achunk-001/)).toHaveCount(2, { timeout: 20_000 });
      expect(await stop()).toBe(200);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 20_000,
      });

      /** Reading the thread back for the second stop finds the first reply already saved. */
      await page.reload();
      await expect(messagesView(page).getByText(second)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/achunk-001/)).toHaveCount(2);
      const transcript = await messagesView(page).innerText();
      const order = [first, 'achunk-001', second].map((part) => transcript.indexOf(part));
      expect(order.every((position) => position >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(transcript.lastIndexOf('achunk-001')).toBeGreaterThan(transcript.indexOf(second));
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a failed assistant run shows an error and settles the composer @scenario:assistants-error-shows-error', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const label = uniqueLabel('assistant-error');
    const assistant = await createAssistant(page, `E2E error ${label}`);
    try {
      await sendToAssistant(page, assistant.id, `E2E_ASSISTANT_ERROR:${label}`);
      /** The Assistants error handler answers a failed run with its own settled message. */
      await expect(
        messagesView(page).getByText(/The Assistant run failed to initialize/),
      ).toBeVisible({ timeout: 30_000 });
      await expect(messagesView(page).getByText(`E2E_ASSISTANT_ERROR:${label}`)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
      /** The error stays: nothing rebuilds the pane into a conversation that never saved it. */
      await page.waitForTimeout(3000);
      await expect(
        messagesView(page).getByText(/The Assistant run failed to initialize/),
      ).toBeVisible();
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a stop the server refuses keeps the streamed reply and shows the failure on it @scenario:assistants-refused-stop-keeps-streamed-reply', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-stop-refused');
    const earlier = `E2E assistant reply ${label}`;
    const assistant = await createAssistant(page, `E2E stop refused ${label}`);
    try {
      await sendToAssistant(page, assistant.id, replyPrompt(label));
      await expect(messagesView(page).getByText(earlier)).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      await send(page, `E2E_ASSISTANT_SLOW:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });

      await page.route('**/api/assistants/v2/chat/abort', (route) =>
        route.fulfill(ACCOUNT_DELETION_REFUSAL),
      );
      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
        page.getByRole('button', { name: 'Stop generating' }).click(),
      ]);
      expect(stopped.status()).toBe(409);

      /** The reply that was streaming keeps its text and takes the failure; the earlier reply
       *  is left as it was, and the refusal's body never reaches the transcript. */
      const rows = messagesView(page).locator('.message-render');
      await expect(rows.filter({ hasText: /achunk-005/ })).toContainText(STOP_FAILURE);
      await expect(rows.filter({ hasText: earlier })).toHaveCount(1);
      await expect(rows.filter({ hasText: earlier })).not.toContainText(STOP_FAILURE);
      await expect(messagesView(page).getByText(CRASH)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill(replyPrompt(`${label}-next`));
      await expect(page.getByTestId('send-button')).toBeEnabled();
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('leaving an assistant run the server has not named for a new chat opens that new chat @scenario:leaving-an-unnamed-assistant-run-for-a-new-chat', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-unnamed-new');
    const prompt = `E2E_ASSISTANT_LATE_RUN:${label}`;
    const next = `${label}-next`;
    const assistant = await createAssistant(page, `E2E unnamed ${label}`);
    try {
      /** The fake Assistants API holds the run's creation, so the app has not named it yet. */
      await sendToAssistant(page, assistant.id, prompt);
      await expect(messagesView(page).getByText(prompt)).toBeVisible();

      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 15_000 }),
        startNewChat(page),
      ]);
      /** Leaving stops the run, and the stop route refuses a run that has no name yet. */
      expect(stopped.status()).toBe(400);
      await expect(page).toHaveURL(/\/c\/new(\?|$)/);
      const pane = page.getByRole('main');
      await expect(pane.getByText(prompt)).toHaveCount(0);
      await expect(pane.getByText(/Unexpected response from server/)).toHaveCount(0);
      await expect(pane.getByText(CRASH)).toHaveCount(0);

      /** The new chat is a working one: its first message gets a reply. */
      await send(page, replyPrompt(next));
      await expect(messagesView(page).getByText(`E2E assistant reply ${next}`)).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('leaving an assistant run the server has not named for a saved chat opens that chat @scenario:leaving-an-unnamed-assistant-run-for-a-saved-chat', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-unnamed-saved');
    const saved = `E2E assistant reply ${label}`;
    const prompt = `E2E_ASSISTANT_LATE_RUN:${label}`;
    const assistant = await createAssistant(page, `E2E unnamed ${label}`);
    try {
      await sendToAssistant(page, assistant.id, replyPrompt(label));
      await expect(messagesView(page).getByText(saved)).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      const savedId = new URL(page.url()).pathname.split('/').pop() ?? '';

      /** The fake Assistants API holds the run's creation, so the app has not named it yet. */
      await sendToAssistant(page, assistant.id, prompt);
      await expect(messagesView(page).getByText(prompt)).toBeVisible();

      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 15_000 }),
        openSavedChat(page, savedId),
      ]);
      expect(stopped.status()).toBe(400);
      await expect(page).toHaveURL(new RegExp(`/c/${savedId}(\\?|$)`));
      await expect(messagesView(page).getByText(saved)).toBeVisible();
      const pane = page.getByRole('main');
      await expect(pane.getByText(prompt)).toHaveCount(0);
      await expect(pane.getByText(CRASH)).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('stopping a run that wrote a message and called a tool keeps each part once @scenario:assistants-stop-keeps-each-run-part-once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-stop-parts');
    const assistant = await createAssistant(page, `E2E stop parts ${label}`);
    try {
      await sendToAssistant(page, assistant.id, `${PARTS}:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      expect(await stopRun(page)).toBe(200);
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      await expect(messagesView(page).getByText(/apart-one/)).toHaveCount(1);

      /** The stop saved the run as one reply: its first message, the tool call, then the cut. */
      await page.reload();
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/apart-one/)).toHaveCount(1);
      expect(await savedReplyParts(page)).toEqual([RUN_PARTS]);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('stopping the next run of the chat keeps the earlier stopped reply whole @scenario:assistants-next-stop-keeps-earlier-parts-once', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('assistant-next-parts');
    const second = `E2E_ASSISTANT_SLOW:second-${label}`;
    const assistant = await createAssistant(page, `E2E next parts ${label}`);
    try {
      await sendToAssistant(page, assistant.id, `${PARTS}:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      expect(await stopRun(page)).toBe(200);
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });

      await send(page, second);
      await expect(messagesView(page).getByText(second)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/achunk-003/)).toHaveCount(2, { timeout: 20_000 });
      expect(await stopRun(page)).toBe(200);

      /** Reading the thread back again finds every message of the first run in its reply. */
      await page.reload();
      await expect(messagesView(page).getByText(second)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/apart-one/)).toHaveCount(1);
      expect(await savedReplyParts(page)).toEqual([RUN_PARTS, ['text']]);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a run whose stream drops keeps each part once in the reply the app reads back @scenario:assistants-dropped-run-keeps-each-part-once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-drop-parts');
    const assistant = await createAssistant(page, `E2E drop parts ${label}`);
    try {
      /** The fake Assistants API cuts the stream; the app reads the run back and shows the error. */
      await sendToAssistant(page, assistant.id, `${PARTS}:E2E_ASSISTANT_DROP:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      await expect(messagesView(page).getByText(/apart-one/)).toHaveCount(1);

      await page.reload();
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      await expect(messagesView(page).getByText(/apart-one/)).toHaveCount(1);
      expect(await savedReplyParts(page)).toEqual([RUN_PARTS]);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a run sent right after a stop can be stopped too, and each run is read back and kept once @scenario:assistants-run-sent-right-after-stop-stops', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('assistant-stop-again');
    const second = `E2E_ASSISTANT_SLOW:second-${label}`;
    const assistant = await createAssistant(page, `E2E stop again ${label}`);
    try {
      await sendToAssistant(page, assistant.id, `E2E_ASSISTANT_SLOW:${label}`);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      expect(await stopRun(page)).toBe(200);

      /** The next run starts while the stopped request is still settling, and streams on past the
       *  moment that request checks its own run again, 2 s after it closed. */
      await send(page, second);
      await expect(messagesView(page).getByText(/achunk-012/)).toHaveCount(1, { timeout: 20_000 });
      const [stopped] = await Promise.all([
        page.waitForResponse(isAssistantsStop, { timeout: 30_000 }),
        page.getByRole('button', { name: 'Stop generating' }).click(),
      ]);
      expect(stopped.status()).toBe(200);
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 20_000,
      });

      await page.waitForTimeout(RECOVERY_CHECK_MS);
      expect(await runReads(page, assistant.id)).toEqual({ runs: 2, reads: [1, 1] });

      /** The chat keeps one reply per run, each as it was when its stop cut it. */
      await page.reload();
      await expect(messagesView(page).getByText(second)).toBeVisible({ timeout: 20_000 });
      expect(await savedReplyParts(page)).toEqual([['text'], ['text']]);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('leaving a chat right after its run failed reads back and bills that run once @scenario:assistants-left-failed-run-recovered-once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-drop-leave');
    const assistant = await createAssistant(page, `E2E drop leave ${label}`);
    try {
      /** The fake Assistants API cuts the stream, and the app cancels, bills and reads the run back. */
      const prompt = `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_DROP:E2E_ASSISTANT_USAGE:${label}`;
      await sendToAssistant(page, assistant.id, prompt);
      await expect(messagesView(page).getByText(/achunk-005/)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      const conversationId = new URL(page.url()).pathname.split('/').pop() ?? '';
      /** Leaving closes the run's stream while its request is still settling. */
      await startNewChat(page);

      await page.waitForTimeout(RECOVERY_CHECK_MS);
      const billed = await billedFor(conversationId);
      expect({ ...(await runReads(page, assistant.id)), billed }).toEqual({
        runs: 1,
        reads: [1],
        billed: 2,
      });
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a v1 client that leaves right after its run failed has that run read back and billed once @scenario:assistants-v1-left-failed-run-recovered-once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-v1-drop-leave');
    const assistant = await createAssistant(page, `E2E v1 drop leave ${label}`, 'v1');
    try {
      const prompt = `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_DROP:E2E_ASSISTANT_USAGE:${label}`;
      const conversationId = await sendAndDrop(page, {
        version: 'v1',
        assistantId: assistant.id,
        text: prompt,
        until: '"final":true',
      });
      expect(conversationId).toBeTruthy();

      await page.waitForTimeout(RECOVERY_CHECK_MS);
      const billed = await billedFor(conversationId);
      expect({ ...(await runReads(page, assistant.id)), billed }).toEqual({
        runs: 1,
        reads: [1],
        billed: 2,
      });
    } finally {
      await deleteAssistant(page, assistant.id, 'v1');
    }
  });

  test('a client whose connection drops just before its run ends has that run billed once @scenario:assistants-dropped-connection-before-run-ends-bills-once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-cut-late');
    const assistant = await createAssistant(page, `E2E cut late ${label}`);
    try {
      /** The run completes a second after the connection drops, inside the 2 s the closed request
       *  waits before it would recover the run itself. */
      const prompt = `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_BRIEF:E2E_ASSISTANT_USAGE:${label}`;
      const conversationId = await sendAndDrop(page, {
        version: 'v2',
        assistantId: assistant.id,
        text: prompt,
        until: 'achunk-008',
      });
      expect(conversationId).toBeTruthy();

      await page.waitForTimeout(RECOVERY_CHECK_MS);
      expect(await billedFor(conversationId)).toBe(2);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });

  test('a run that completed but could not be tagged at the provider is still billed once @scenario:assistants-completed-run-tag-failure-bills-once', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const label = uniqueLabel('assistant-tag-fail');
    const assistant = await createAssistant(page, `E2E tag fail ${label}`);
    try {
      /** The run completes, then tagging its message at the provider fails before the controller
       *  bills it, so the request recovers the run itself. */
      const prompt = `E2E_ASSISTANT_SLOW:E2E_ASSISTANT_BRIEF:E2E_ASSISTANT_USAGE:E2E_ASSISTANT_TAG_FAIL:${label}`;
      await sendToAssistant(page, assistant.id, prompt);
      await expect(messagesView(page).getByText(/achunk-012/)).toBeVisible({ timeout: 20_000 });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/, { timeout: 15_000 });
      const conversationId = new URL(page.url()).pathname.split('/').pop() ?? '';

      await page.waitForTimeout(RECOVERY_CHECK_MS);
      expect(await billedFor(conversationId)).toBe(2);
    } finally {
      await deleteAssistant(page, assistant.id);
    }
  });
});
