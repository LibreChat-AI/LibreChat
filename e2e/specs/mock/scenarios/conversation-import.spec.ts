import { randomUUID } from 'crypto';
import JSZip from 'jszip';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { FiltersConfig } from 'librechat-data-provider';
import {
  loginAdmin,
  requestResult,
  restoreRuntimeFilters,
  setRuntimeFilters,
} from '../content-filters.helpers';
import type { RequestResult } from '../content-filters.helpers';
import { withMongo } from '../db';

/**
 * Conversation import through Settings > Data & Privacy and its API. Every
 * export carries fresh conversation ids, so the deduplication these scenarios
 * observe is scoped to the export each one builds, whatever else the run's
 * user already imported.
 *
 * The settings dialog sits behind the mobile drawer on a phone-width viewport,
 * so the UI scenarios pin a desktop viewport, like the other settings scenarios.
 */

test.use({ viewport: { width: 1280, height: 800 } });

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

interface ImportJobBody {
  jobId?: string;
  phase?: string;
  report?: { imported: number; skipped: number; errors: unknown[] } | null;
}

interface ChatGptConversation {
  id: string;
  title: string;
  text: string;
}

function chatGptConversation({ id, title, text }: ChatGptConversation) {
  const createTime = 1700000000;
  return {
    conversation_id: id,
    title,
    create_time: createTime,
    update_time: createTime + 100,
    default_model_slug: 'gpt-4o',
    is_archived: false,
    pinned_time: null,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['a1'],
        message: {
          id: 'u1',
          author: { role: 'user', name: null },
          create_time: createTime + 1,
          content: { content_type: 'text', parts: [text] },
        },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: {
          id: 'a1',
          author: { role: 'assistant', name: null },
          create_time: createTime + 2,
          content: { content_type: 'text', parts: ['Imported answer.'] },
          metadata: { model_slug: 'gpt-4o' },
        },
      },
    },
  };
}

async function chatGptExport(conversation: ChatGptConversation): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('conversations.json', JSON.stringify([chatGptConversation(conversation)]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function freshConversation(text = 'Where should I stay?'): ChatGptConversation {
  const suffix = randomUUID();
  return { id: `ext-${suffix}`, title: `Imported trip ${suffix.slice(0, 8)}`, text };
}

function expectStatus(result: RequestResult, status: number): void {
  expect(result.status, result.text).toBe(status);
}

async function upload(
  request: APIRequestContext,
  token: string,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<RequestResult> {
  return requestResult(request, {
    path: '/api/convos/import',
    token,
    method: 'POST',
    multipart: { file },
  });
}

/** Uploads, confirms, and waits for the job to settle. */
async function importArchive(
  request: APIRequestContext,
  token: string,
  buffer: Buffer,
): Promise<ImportJobBody> {
  const uploaded = await upload(request, token, {
    name: 'chatgpt-export.zip',
    mimeType: 'application/zip',
    buffer,
  });
  expectStatus(uploaded, 202);
  const jobId = (uploaded.body as ImportJobBody).jobId;
  expect(jobId, uploaded.text).toEqual(expect.any(String));

  const started = await requestResult(request, {
    path: `/api/convos/import/jobs/${jobId}/start`,
    token,
    method: 'POST',
  });
  expectStatus(started, 202);

  let job: ImportJobBody = {};
  await expect
    .poll(
      async () => {
        const result = await requestResult(request, {
          path: `/api/convos/import/jobs/${jobId}`,
          token,
        });
        job = result.body as ImportJobBody;
        return job.phase;
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toMatch(/^(completed|failed|cancelled)$/);
  return job;
}

async function countImported(externalId: string): Promise<number> {
  return withMongo((db) =>
    db.collection('conversations').countDocuments({ 'importedFrom.externalId': externalId }),
  );
}

async function openDataSettings(page: Page) {
  await page.goto('/c/new', { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: 'Data & Privacy' }).click();
  return dialog;
}

test.describe('conversation import', () => {
  test('a ChatGPT archive is summarized, confirmed, and lands in the chat list @scenario:chatgpt-archive-import-lands-in-chat-list', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const conversation = freshConversation();
    const dialog = await openDataSettings(page);

    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'chatgpt-export.zip',
      mimeType: 'application/zip',
      buffer: await chatGptExport(conversation),
    });

    await expect(dialog.getByText('Detected ChatGPT export')).toBeVisible({ timeout: 30000 });
    await expect(dialog.getByText('1 conversations', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    const status = dialog.getByRole('status');
    await expect(status).toContainText('Import complete', { timeout: 30000 });
    await expect(status).toContainText('1 conversations imported, 0 skipped');
    await expect.poll(() => countImported(conversation.id)).toBe(1);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(conversation.title).first()).toBeVisible({ timeout: 15000 });
  });

  test('importing the same archive again skips what was already imported @scenario:reimport-skips-already-imported', async ({
    request,
  }) => {
    test.setTimeout(90000);
    const token = await loginAdmin(request);
    const conversation = freshConversation();
    const buffer = await chatGptExport(conversation);

    const first = await importArchive(request, token, buffer);
    expect(first.phase).toBe('completed');
    expect(first.report).toMatchObject({ imported: 1, skipped: 0 });

    const second = await importArchive(request, token, buffer);
    expect(second.phase).toBe('completed');
    expect(second.report).toMatchObject({ imported: 0, skipped: 1 });
    expect(await countImported(conversation.id)).toBe(1);
  });

  test('an unsupported file is refused with a readable error @scenario:unsupported-import-file-is-refused', async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    const token = await loginAdmin(request);
    const refused = await upload(request, token, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an export'),
    });
    expectStatus(refused, 415);
    expect(refused.body).toEqual({ message: 'Unsupported import type' });

    const dialog = await openDataSettings(page);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not an export'),
    });
    await expect(page.getByText('Unsupported import type').first()).toBeVisible({
      timeout: 15000,
    });
    await expect(dialog.getByText(/Detected .* export/)).toHaveCount(0);
  });

  test('a LibreChat JSON export imports directly without a job @scenario:legacy-librechat-json-imports-directly', async ({
    request,
  }) => {
    test.setTimeout(60000);
    const token = await loginAdmin(request);
    const conversationId = randomUUID();
    const title = `Legacy import ${conversationId.slice(0, 8)}`;
    const messageId = randomUUID();

    const result = await upload(request, token, {
      name: 'librechat-export.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          conversationId,
          title,
          endpoint: 'openAI',
          messages: [
            {
              messageId,
              parentMessageId: NO_PARENT,
              text: 'Hello from the legacy export',
              sender: 'User',
              isCreatedByUser: true,
            },
            {
              messageId: randomUUID(),
              parentMessageId: messageId,
              text: 'Legacy answer',
              sender: 'GPT',
              isCreatedByUser: false,
            },
          ],
        }),
      ),
    });

    expectStatus(result, 201);
    await expect
      .poll(() => withMongo((db) => db.collection('conversations').countDocuments({ title })))
      .toBe(1);
  });

  test('content filters block a matching import on both import paths @scenario:import-honors-content-filters', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const token = await loginAdmin(request);
    const marker = `IMPORT-BLOCK-${randomUUID()}`;
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [{ id: 'import-block', label: 'import block', regex: marker }],
        },
      },
    };

    let filtersAttempted = false;
    try {
      filtersAttempted = true;
      await setRuntimeFilters(request, token, filters);

      await test.step('background archive job', async () => {
        const blocked = freshConversation(`Please keep ${marker} private`);
        const job = await importArchive(request, token, await chatGptExport(blocked));
        expect(job.phase).toBe('failed');
        expect(await countImported(blocked.id)).toBe(0);

        const allowed = freshConversation();
        const clean = await importArchive(request, token, await chatGptExport(allowed));
        expect(clean.phase).toBe('completed');
        expect(await countImported(allowed.id)).toBe(1);
      });

      await test.step('legacy JSON import', async () => {
        const title = `Blocked legacy ${randomUUID().slice(0, 8)}`;
        const result = await upload(request, token, {
          name: 'librechat-export.json',
          mimeType: 'application/json',
          buffer: Buffer.from(
            JSON.stringify({
              conversationId: randomUUID(),
              title,
              endpoint: 'openAI',
              messages: [
                {
                  messageId: randomUUID(),
                  parentMessageId: NO_PARENT,
                  text: `Legacy ${marker}`,
                  sender: 'User',
                  isCreatedByUser: true,
                },
              ],
            }),
          ),
        });
        expect(result.status, result.text).toBeGreaterThanOrEqual(400);
        expect(result.status, result.text).toBeLessThan(500);
        expect(result.text).not.toContain(marker);
        expect(
          await withMongo((db) => db.collection('conversations').countDocuments({ title })),
        ).toBe(0);
      });
    } finally {
      if (filtersAttempted) {
        await restoreRuntimeFilters(request, token);
      }
    }
  });
});
