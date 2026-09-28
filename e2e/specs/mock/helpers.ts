import { expect } from '@playwright/test';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { Page, Response } from '@playwright/test';

/** Substring of the reply emitted by the mock LLM server. */
export const MOCK_REPLY_TEXT = 'E2E mock reply';

/** Custom endpoints defined in e2e/config/librechat.e2e.yaml. */
export const MOCK_ENDPOINTS = [
  { label: 'Mock Provider A', model: 'mock-model-a' },
  { label: 'Mock Provider B', model: 'mock-model-b' },
] as const;

export type MockEndpoint = { label: string; model: string };

export const NEW_CHAT_PATH = '/c/new';

type RefreshTokenBody = {
  token?: string;
};

type AgentGenerationStart = {
  conversationId?: string;
};

type CompletionOptions = {
  timeout?: number;
};

const DEFAULT_COMPLETION_TIMEOUT = 20_000;

export function isAgentsStream(response: Response) {
  return isAgentGenerationStart(response);
}

export function isAgentGenerationStart(response: Response) {
  const { pathname } = new URL(response.url());
  const isAgentsChat = pathname === '/api/agents/chat' || pathname.startsWith('/api/agents/chat/');
  return (
    response.request().method() === 'POST' &&
    isAgentsChat &&
    !pathname.endsWith('/abort') &&
    response.status() === 200
  );
}

const modelSelectorTrigger = (page: Page) =>
  page.getByRole('button', { name: 'Select a model' }).first();

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Open the model selector, choose an endpoint, then its model (committed on the model click). */
export async function selectMockEndpoint(page: Page, endpoint: MockEndpoint) {
  const trigger = modelSelectorTrigger(page);
  await trigger.click();
  await page.getByRole('option', { name: endpoint.label }).click();
  const modelOption = page.getByRole('option', { name: endpoint.model, exact: true });
  if (await modelOption.isVisible({ timeout: 1000 }).catch(() => false)) {
    await modelOption.click();
  }
  await expect(trigger).not.toHaveText('Select a model');
}

/** Open the model selector and choose a configured model spec by label. */
export async function selectModelSpec(page: Page, label: string) {
  const trigger = modelSelectorTrigger(page);
  await expect(trigger).toBeVisible();
  if ((await trigger.textContent())?.includes(label)) {
    return;
  }
  await trigger.click();
  await page.getByRole('option', { name: new RegExp(`(^|\\s)${escapeRegExp(label)}\\b`) }).click();
  await expect(trigger).toContainText(label);
}

/** Enable the ephemeral Skills capability from the composer tool menu. */
export async function enableSkills(page: Page) {
  await page.getByRole('button', { name: 'Tools Options' }).click();
  await page.getByTestId('tools-menu-skills').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Skills' })).toBeVisible();
}

/** Enable the ephemeral Memory capability from the composer tool menu. */
export async function enableMemory(page: Page) {
  await page.getByRole('button', { name: 'Tools Options' }).click();
  await page.getByTestId('tools-menu-memory').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name: 'Memory' })).toBeVisible();
}

/** Enable the ephemeral Code Interpreter (execute_code) capability from the tool menu. */
export async function enableCodeInterpreter(page: Page) {
  await page.getByRole('button', { name: 'Tools Options' }).click();
  await page.getByTestId('tools-menu-run-code').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name: 'Run Code' })).toBeVisible();
}

/** Enable the ephemeral File Search capability from the composer tool menu. */
export async function enableFileSearch(page: Page) {
  await page.getByRole('button', { name: 'Tools Options' }).click();
  await page.getByTestId('tools-menu-file-search').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('checkbox', { name: 'File Search' })).toBeVisible();
}

/** The conversation messages container. */
export const messagesView = (page: Page) => page.getByTestId('messages-view');

/** Build the mock-model reply trigger and its expected rendered text for a label. */
export const replyPrompt = (label: string) => `E2E_REPLY:${label}`;
export const replyText = (label: string) => `E2E reply ${label}`;

/** Same, for a reply that streams a reasoning part ahead of its text part. */
export const thinkPrompt = (label: string) => `E2E_THINK_REPLY:${label}`;
export const thinkText = (label: string) => `E2E reasoning ${label}`;

/** The mock reply as rendered in the conversation, scoped to the messages view. */
export function mockReply(page: Page) {
  return messagesView(page).getByText(new RegExp(MOCK_REPLY_TEXT, 'i'));
}

/**
 * Type a message and wait only for generation admission. Use this lower-level
 * helper when a test intentionally observes a live, paused, aborted, or failed run.
 */
export async function sendMessage(page: Page, text: string): Promise<Response> {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  await input.fill(text);
  const [response] = await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30000 }),
    input.press('Enter'),
  ]);
  return response;
}

function formatPersistedMessages(messages: TMessage[]): string {
  return JSON.stringify(
    messages.map(
      ({ content, error, isCreatedByUser, messageId, parentMessageId, text, unfinished }) => ({
        messageId,
        parentMessageId,
        isCreatedByUser,
        unfinished,
        error,
        text: typeof text === 'string' ? text.slice(0, 200) : text,
        content: content?.map((part) => ({
          type: part?.type,
          ...(part?.type === ContentTypes.ERROR
            ? { error: part[ContentTypes.ERROR], text: part.text }
            : {}),
        })),
      }),
    ),
    null,
    2,
  );
}

function conversationIdFromUrl(url: string): string | undefined {
  const match = new URL(url).pathname.match(/^\/c\/([^/]+)\/?$/);
  const conversationId = match?.[1];
  return conversationId && conversationId !== 'new'
    ? decodeURIComponent(conversationId)
    : undefined;
}

/**
 * Send a message and require the resulting assistant response to be durably finalized.
 * A streamed answer is not success until its persisted message is terminal and error-free.
 */
export async function sendMessageAndWaitForCompletion(
  page: Page,
  text: string,
  options: CompletionOptions = {},
): Promise<Response> {
  const token = await getAccessToken(page);
  const existingConversationId = conversationIdFromUrl(page.url());
  /** The POST messageId is an optimistic UI placeholder; BaseClient persists a
   * server-generated user ID. Snapshot history before admission so the new
   * canonical user→assistant edge can be identified without matching prompt text. */
  const existingMessages = existingConversationId
    ? await fetchJson<TMessage[]>(
        page,
        `/api/messages/${encodeURIComponent(existingConversationId)}`,
        token,
      )
    : [];
  const existingMessageIds = new Set(existingMessages.map((message) => message.messageId));

  const response = await sendMessage(page, text);
  const start = (await response.json()) as AgentGenerationStart;
  const conversationId = start.conversationId;

  if (!conversationId || conversationId === 'new') {
    throw new Error(
      `Generation admission did not identify a persisted turn: ${JSON.stringify({
        conversationId,
      })}`,
    );
  }
  if (existingConversationId && existingConversationId !== conversationId) {
    throw new Error(
      `Generation admission changed conversations unexpectedly: ${JSON.stringify({
        existingConversationId,
        conversationId,
      })}`,
    );
  }

  let assistantMessages: TMessage[] = [];
  let newMessages: TMessage[] = [];
  let latestMessages: TMessage[] = [];
  let latestReadError: string | undefined;

  try {
    await expect
      .poll(
        async () => {
          try {
            latestMessages = await fetchJson<TMessage[]>(
              page,
              `/api/messages/${encodeURIComponent(conversationId)}`,
              token,
            );
            latestReadError = undefined;
          } catch (error) {
            latestReadError = error instanceof Error ? error.message : String(error);
            return false;
          }

          newMessages = latestMessages.filter(
            (message) => !existingMessageIds.has(message.messageId),
          );
          const userMessageIds = new Set(
            newMessages
              .filter((message) => message.isCreatedByUser === true)
              .map((message) => message.messageId),
          );
          assistantMessages = newMessages.filter(
            (message) =>
              message.isCreatedByUser === false &&
              message.parentMessageId != null &&
              userMessageIds.has(message.parentMessageId),
          );
          return (
            userMessageIds.size > 0 &&
            assistantMessages.length > 0 &&
            assistantMessages.every((message) => message.unfinished === false)
          );
        },
        {
          timeout: options.timeout ?? DEFAULT_COMPLETION_TIMEOUT,
          intervals: [250, 500, 1_000],
          message: 'new assistant response should be durably finalized',
        },
      )
      .toBe(true);
  } catch (error) {
    const pollError = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        'Timed out waiting for the new assistant response to be durably finalized.',
        latestReadError ? `Latest message read failed: ${latestReadError}` : undefined,
        `Pre-existing message IDs: ${JSON.stringify([...existingMessageIds])}`,
        `New persisted messages: ${formatPersistedMessages(newMessages)}`,
        `Persisted messages: ${formatPersistedMessages(latestMessages)}`,
        pollError,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  const failedMessage = assistantMessages.find(
    (message) =>
      message.error === true ||
      message.content?.some((part) => part?.type === ContentTypes.ERROR) === true,
  );
  if (failedMessage) {
    throw new Error(
      `Persisted assistant response contains an unexpected error: ${formatPersistedMessages([
        failedMessage,
      ])}`,
    );
  }

  if (!existingConversationId) {
    await expect
      .poll(() => conversationIdFromUrl(page.url()), {
        timeout: 5_000,
        intervals: [100, 250, 500],
        message: 'new conversation route should use the admitted conversation ID',
      })
      .toBe(conversationId);
  }

  return response;
}

export async function getAccessToken(page: Page): Promise<string> {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, text, json };
  });

  if (!result.ok) {
    throw new Error(
      `Expected /api/auth/refresh to return 2xx, got ${result.status}: ${result.text}`,
    );
  }

  const body = result.json as RefreshTokenBody | null;
  if (!body?.token) {
    throw new Error(`Expected /api/auth/refresh to return a token, got: ${result.text}`);
  }

  return body.token;
}

export async function requestJson<T>(
  page: Page,
  params: {
    path: string;
    token: string;
    method?: string;
    body?: unknown;
  },
): Promise<T> {
  const result = await page.evaluate(
    async ({ accessToken, body, method, urlPath }) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
      };
      const init: RequestInit = {
        method,
        credentials: 'include',
        headers,
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(urlPath, init);
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: response.ok, status: response.status, text, json };
    },
    {
      accessToken: params.token,
      body: params.body,
      method: params.method ?? 'GET',
      urlPath: params.path,
    },
  );

  if (!result.ok) {
    throw new Error(
      `Expected ${params.method ?? 'GET'} ${params.path} to return 2xx, got ${result.status}: ${result.text}`,
    );
  }
  return result.json as T;
}

export async function fetchJson<T>(page: Page, path: string, token: string): Promise<T> {
  return requestJson<T>(page, { path, token });
}

/** Base URLs of the fake code-exec + RAG servers started by playwright.config.mock.ts. */
/** Defaults must match `playwright.config.mock.ts`, which keeps these clear of
 *  the MCP (8765/8766) and label (8889) fixtures. */
export const CODE_API_BASE = `http://127.0.0.1:${process.env.E2E_CODE_API_PORT || '8790'}`;
export const RAG_API_BASE = `http://127.0.0.1:${process.env.E2E_RAG_API_PORT || '8791'}`;

export type CodeProvisionRecord = {
  filename: string;
  kind: string;
  id: string;
  storage_session_id: string;
  fileId: string;
};

export type RagEmbedRecord = { file_id: string; filename: string; entity_id: string };

/** Files the fake code server received via /upload (proof they reached the code env). */
export async function getCodeProvisionedUploads(page: Page): Promise<CodeProvisionRecord[]> {
  const response = await page.request.get(`${CODE_API_BASE}/__debug/uploads`);
  expect(response.ok(), 'fake code server /__debug/uploads should respond').toBeTruthy();
  const body = (await response.json()) as { uploads: CodeProvisionRecord[] };
  return body.uploads;
}

/** Files the fake RAG server embedded via /embed (proof they reached the vector DB). */
export async function getRagEmbedded(page: Page): Promise<RagEmbedRecord[]> {
  const response = await page.request.get(`${RAG_API_BASE}/__debug/embedded`);
  expect(response.ok(), 'fake RAG server /__debug/embedded should respond').toBeTruthy();
  const body = (await response.json()) as { embedded: RagEmbedRecord[] };
  return body.embedded;
}

/** Clear both fake servers' recorded provisioning (call at test start for isolation). */
export async function resetProvisioning(page: Page): Promise<void> {
  await Promise.all([
    page.request.post(`${CODE_API_BASE}/__debug/reset`),
    page.request.post(`${RAG_API_BASE}/__debug/reset`),
  ]);
}

/** Shape of a file record as returned by POST /api/files and GET /api/files. */
export type UploadedFile = {
  file_id?: string;
  filename?: string;
  type?: string;
  llmDeliveryPath?: string;
  embedded?: boolean;
  metadata?: { codeEnvRef?: { storage_session_id?: string; file_id?: string } };
};

export type AttachFile = { name: string; mimeType: string; content: string };

/** Unique, filesystem-safe name so tests never collide on accumulated fake-server state. */
export const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const isFilesUpload = (url: string, method: string) =>
  method === 'POST' && /\/api\/files(?:\?|$)/.test(new URL(url).pathname);

/** Wait for the next POST /api/files upload response. */
export function waitForUpload(page: Page) {
  return page.waitForResponse((r) => isFilesUpload(r.url(), r.request().method()), {
    timeout: 30000,
  });
}

/** Attach a file via the unified single button (no tool resource). */
export async function uploadViaUnifiedButton(page: Page, file: AttachFile) {
  const uploadResponse = waitForUpload(page);
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#attach-file-button').click(),
  ]);
  await fileChooser.setFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.content, 'utf8'),
  });
  return uploadResponse;
}

/** Attach a file via a named option in the legacy 3-way dropdown. */
export async function uploadViaLegacyOption(page: Page, optionName: string, file: AttachFile) {
  const uploadResponse = waitForUpload(page);
  await page.locator('#attach-file-menu-button').click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: optionName }).click(),
  ]);
  await fileChooser.setFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.content, 'utf8'),
  });
  return uploadResponse;
}
