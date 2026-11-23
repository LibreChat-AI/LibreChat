import { expect, test } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  RAG_API_BASE,
  uniqueName,
  requestJson,
  getAccessToken,
  getRagQueries,
  getRagEmbedded,
  enableFileSearch,
  resetProvisioning,
  selectMockEndpoint,
  uploadViaLegacyOption,
  uploadViaUnifiedButton,
  sendMessageAndWaitForCompletion,
} from '../helpers';

test.describe('outbound timeouts', () => {
  test.afterEach(async ({ request }) => {
    await request.post(`${RAG_API_BASE}/__debug/stall`, { data: { stall: false } });
  });

  /* The e2e config sets timeouts.ragMs to 3s; without a budget the stalled query held the
     tool call, and with it the whole turn, open indefinitely. */
  test('a file search against a stalled RAG API still finishes the turn @scenario:stalled-rag-query-finishes-the-turn', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    await resetProvisioning(page);
    await enableFileSearch(page);

    const fileName = `${uniqueName('stalled-rag')}.csv`;
    const upload = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/csv',
      content: 'k,v\nfoo,bar\n',
    });
    expect(upload.ok()).toBeTruthy();
    const fileId = ((await upload.json()) as UploadedFile).file_id;
    await expect(
      page.getByTestId('composer-tray').getByRole('button', { name: fileName }),
    ).toBeVisible({ timeout: 15_000 });

    const stall = await request.post(`${RAG_API_BASE}/__debug/stall`, { data: { stall: true } });
    expect(stall.ok()).toBeTruthy();

    const startedAt = Date.now();
    await sendMessageAndWaitForCompletion(page, `E2E_FILE_SEARCH:${uniqueName('stalled')}`);

    expect((await getRagQueries(page)).some((query) => query.file_id === fileId)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  });
});

test.describe('outbound timeouts on file deletion', () => {
  test.afterEach(async ({ request }) => {
    await request.post(`${RAG_API_BASE}/__debug/stall`, { data: { stall: false } });
  });

  /* The e2e config sets timeouts.ragMs to 3s; a RAG API that never answers the vector delete
     used to hold the delete request open, and now the delete fails once the budget runs out
     while the file stays in place. */
  test('deleting a file against a stalled RAG API fails within the budget @scenario:stalled-rag-delete-fails-fast', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    await resetProvisioning(page);
    await enableFileSearch(page);

    const fileName = `${uniqueName('stalled-delete')}.csv`;
    const upload = await uploadViaLegacyOption(page, 'Upload for File Search', {
      name: fileName,
      mimeType: 'text/csv',
      content: 'k,v\nfoo,bar\n',
    });
    expect(upload.ok()).toBeTruthy();
    const uploaded = (await upload.json()) as UploadedFile & { filepath?: string };
    const fileId = uploaded.file_id ?? '';
    await expect
      .poll(async () => (await getRagEmbedded(page)).some((entry) => entry.file_id === fileId), {
        timeout: 15_000,
      })
      .toBe(true);

    const stall = await request.post(`${RAG_API_BASE}/__debug/stall`, { data: { stall: true } });
    expect(stall.ok()).toBeTruthy();

    const token = await getAccessToken(page);
    const startedAt = Date.now();
    await page.evaluate(
      async ({ accessToken, file }) => {
        await fetch('/api/files', {
          method: 'DELETE',
          credentials: 'include',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [file] }),
        });
      },
      {
        accessToken: token,
        file: { file_id: fileId, filepath: uploaded.filepath, embedded: true },
      },
    );
    expect(Date.now() - startedAt).toBeLessThan(30_000);

    const listed = await requestJson<Array<{ file_id: string }>>(page, {
      path: '/api/files',
      token,
    });
    expect(listed.some((file) => file.file_id === fileId)).toBe(true);
  });
});
