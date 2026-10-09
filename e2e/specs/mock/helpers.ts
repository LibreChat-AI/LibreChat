import fs from 'fs';
import path from 'path';
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
  /** Automatic reading policy, no route overrides (automatic-upload.spec.ts). */
  { label: 'Mock Auto Provider', model: 'mock-auto-model' },
  /** Automatic reading policy with a 1 MB per-file limit. */
  { label: 'Mock Auto Small Provider', model: 'mock-auto-small-model' },
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

/** Toggle a built-in tool row on from the composer palette and wait for its chip. */
async function enableBuiltinTool(page: Page, label: string) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const row = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: label, exact: true });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(
    page.getByTestId('composer-active-builtin').filter({ hasText: label }),
  ).toBeVisible();
  /* Wait for the palette to finish closing. Reopening it during the leave
     animation resumes the same popover rather than mounting a fresh one, so the
     list keeps the scroll offset this click left it at, and the Attach rows at
     the top sit outside the virtualized window a caller then queries. */
  await expect(page.getByRole('dialog', { name: 'Attach and tools' })).toHaveCount(0);
}

/** Enable the ephemeral Skills capability from the composer palette. */
export async function enableSkills(page: Page) {
  await enableBuiltinTool(page, 'Skills');
}

/** Enable the ephemeral Memory capability from the composer palette. */
export async function enableMemory(page: Page) {
  await enableBuiltinTool(page, 'Memory');
}

/** Enable the ephemeral Code Interpreter (execute_code) capability from the palette. */
export async function enableCodeInterpreter(page: Page) {
  await enableBuiltinTool(page, 'Run Code');
}

/** Enable the ephemeral File Search capability from the composer palette. */
export async function enableFileSearch(page: Page) {
  await enableBuiltinTool(page, 'File Search');
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
  bytes: number;
  /** Hex digest of the bytes the code server received. */
  sha256: string;
};

/** One exec the fake code server ran: the files it mounted, and the one an analysis token read. */
export type CodeExecRecord = {
  lang: string;
  fileCount: number;
  files: Array<{ id: string; name: string }>;
  analyzedFileId?: string;
};

/** `seq` orders embeds and queries against each other across both logs. */
export type RagEmbedRecord = { seq: number; file_id: string; filename: string; entity_id: string };
export type RagQueryRecord = { seq: number; file_id: string; query: string };

/** Every `/query` the fake RAG service received from file_search. */
export async function getRagQueries(page: Page): Promise<RagQueryRecord[]> {
  const response = await page.request.get(`${RAG_API_BASE}/__debug/embedded`);
  expect(response.ok(), 'fake RAG server /__debug/embedded should respond').toBeTruthy();
  const body = (await response.json()) as { queries: RagQueryRecord[] };
  return body.queries;
}

/** The fake code server's record of what it received and ran since the last reset. */
async function getCodeDebug(page: Page): Promise<{
  uploads: CodeProvisionRecord[];
  execs: CodeExecRecord[];
}> {
  const response = await page.request.get(`${CODE_API_BASE}/__debug/uploads`);
  expect(response.ok(), 'fake code server /__debug/uploads should respond').toBeTruthy();
  return response.json();
}

/** Files the fake code server received via /upload (proof they reached the code env). */
export const getCodeProvisionedUploads = async (page: Page): Promise<CodeProvisionRecord[]> =>
  (await getCodeDebug(page)).uploads;

/** Every exec the fake code server ran since the last reset. */
export const getCodeExecs = async (page: Page): Promise<CodeExecRecord[]> =>
  (await getCodeDebug(page)).execs;

/** Files the fake RAG server embedded via /embed (proof they reached the vector DB). */
export async function getRagEmbedded(page: Page): Promise<RagEmbedRecord[]> {
  const response = await page.request.get(`${RAG_API_BASE}/__debug/embedded`);
  expect(response.ok(), 'fake RAG server /__debug/embedded should respond').toBeTruthy();
  const body = (await response.json()) as { embedded: RagEmbedRecord[] };
  return body.embedded;
}

/** Clear both fake servers' recorded provisioning (call at test start for isolation). */
export async function resetProvisioning(page: Page): Promise<void> {
  const [code, rag] = await Promise.all([
    page.request.post(`${CODE_API_BASE}/__debug/reset`),
    page.request.post(`${RAG_API_BASE}/__debug/reset`),
  ]);
  expect(code.ok(), 'fake code server /__debug/reset should succeed').toBeTruthy();
  expect(rag.ok(), 'fake RAG server /__debug/reset should succeed').toBeTruthy();
}

/**
 * Where the in-process fake model writes the prompts of its most recent runs
 * (e2e/setup/fake-model.js). It has no HTTP surface, so the file is its debug endpoint.
 */
export const MODEL_REQUEST_LOG_PATH =
  process.env.E2E_MODEL_REQUEST_LOG ??
  path.resolve(__dirname, '../../.generated/last-request.json');

/** One model invocation as the provider would have received it. */
export type ModelRequestRecord = {
  /** The system instructions, including the queued code files and the file inventory. */
  systemText: string;
  /** Every message's readable text, system first; inline file data is left out. */
  promptText: string;
  /** File names of the document and file parts sent to the model. */
  documentFiles: string[];
};

/** One run of the fake model, keyed by the user text that started it. */
export type ModelRunRecord = {
  sequence: number;
  conversationId: string | null;
  userText: string;
  invocations: ModelRequestRecord[];
};

function readModelRuns(): ModelRunRecord[] {
  try {
    const log = JSON.parse(fs.readFileSync(MODEL_REQUEST_LOG_PATH, 'utf8')) as {
      runs?: ModelRunRecord[];
    };
    return log.runs ?? [];
  } catch {
    return [];
  }
}

/**
 * The latest fake-model run whose user text contains `label`, once it has recorded at least
 * `minInvocations` model requests.
 */
export async function getModelRun(
  label: string,
  { minInvocations = 1, timeout = 15_000 }: { minInvocations?: number; timeout?: number } = {},
): Promise<ModelRunRecord> {
  let match: ModelRunRecord | undefined;
  await expect
    .poll(
      () => {
        match = readModelRuns()
          .filter((run) => run.userText.includes(label))
          .pop();
        return match?.invocations.length ?? 0;
      },
      {
        timeout,
        message: `the fake model should record ${minInvocations} request(s) for "${label}"`,
      },
    )
    .toBeGreaterThanOrEqual(minInvocations);
  if (!match) {
    throw new Error(`No fake-model request was recorded for "${label}"`);
  }
  return match;
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

/** A file to attach: inline text, or a fixture read from disk under the given name. */
export type AttachFile =
  | { name: string; mimeType: string; content: string }
  | { name: string; mimeType: string; path: string };

/** The bytes the browser receives for an attach helper's file. */
export const attachFileBuffer = (file: AttachFile): Buffer =>
  'path' in file ? fs.readFileSync(file.path) : Buffer.from(file.content, 'utf8');

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

/** Attach a file through the palette's implicit local/provider source row. */
export async function uploadViaUnifiedButton(page: Page, file: AttachFile) {
  const uploadResponse = waitForUpload(page);
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
  const sourceRow = palette.getByRole('button', {
    name: /^(From Local Computer|Upload to Provider)$/,
  });
  await expect(sourceRow).toBeVisible();
  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), sourceRow.click()]);
  await fileChooser.setFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: attachFileBuffer(file),
  });
  /* The palette lists the new record while it closes, which would duplicate the chip's name. */
  await expect(palette).toBeHidden();
  return uploadResponse;
}

/** A DataTransfer in the page holding one file, as a native drag or a file paste carries it. */
function createFileTransfer(page: Page, file: AttachFile) {
  return page.evaluateHandle(
    ({ name, mimeType, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: mimeType }));
      return transfer;
    },
    { name: file.name, mimeType: file.mimeType, base64: attachFileBuffer(file).toString('base64') },
  );
}

/** Drop a file onto the composer with the event sequence a native file drag produces. */
export async function uploadViaDrop(page: Page, file: AttachFile) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
  const dataTransfer = await createFileTransfer(page, file);
  const uploadResponse = waitForUpload(page);
  await input.dispatchEvent('dragenter', { dataTransfer });
  await input.dispatchEvent('dragover', { dataTransfer });
  await input.dispatchEvent('drop', { dataTransfer });
  return uploadResponse;
}

/** Whether the browser exposes files on a synthetic paste event, which file paste needs. */
export function supportsFilePaste(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['probe'], 'probe.txt', { type: 'text/plain' }));
    const event = new ClipboardEvent('paste', { clipboardData: transfer });
    return event.clipboardData?.files.length === 1;
  });
}

/** Paste a file into the composer as the clipboard delivers a copied file. */
export async function uploadViaPaste(page: Page, file: AttachFile) {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  const clipboardData = await createFileTransfer(page, file);
  const uploadResponse = waitForUpload(page);
  await input.evaluate((element, transfer) => {
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, clipboardData);
  return uploadResponse;
}

const legacyDestinationRows: Record<string, { key: string; label: string }> = {
  'Upload to Code Environment': {
    key: 'local:execute_code',
    label: 'Upload to Code Environment',
  },
  'Upload for File Search': {
    key: 'local:file_search',
    label: 'Upload for File Search',
  },
};

/** Attach through a named legacy destination row in the composer palette. */
export async function uploadViaLegacyOption(page: Page, optionName: string, file: AttachFile) {
  const destination = legacyDestinationRows[optionName];
  if (destination == null) {
    throw new Error(`Unsupported legacy upload destination: ${optionName}`);
  }

  const uploadResponse = waitForUpload(page);
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
  const moreOptions = palette.getByRole('button', { name: 'More upload options', exact: true });
  await expect(moreOptions).toBeVisible();
  await moreOptions.click();
  const destinationRow = palette
    .locator(`[data-row-key="${destination.key}"]`)
    .getByRole('button', {
      name: destination.label,
      exact: true,
    });
  await expect(destinationRow).toBeVisible();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    destinationRow.click(),
  ]);
  await fileChooser.setFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: attachFileBuffer(file),
  });
  return uploadResponse;
}

/** Identity stays stable when Running and Finished reorder the sidebar. */
export const conversationRow = (page: Page, conversationUrl: string = page.url()) => {
  const id = new URL(conversationUrl).pathname.split('/c/')[1];
  expect(id).toMatch(/^[0-9a-f-]{36}$/i);
  return page
    .getByTestId('convo-item')
    .and(page.locator(`[data-conversation-id="${id}"]`))
    .first();
};
