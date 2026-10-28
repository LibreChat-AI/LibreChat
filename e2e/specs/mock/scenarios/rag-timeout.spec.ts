import { expect, test } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  RAG_API_BASE,
  uniqueName,
  getRagQueries,
  enableFileSearch,
  resetProvisioning,
  selectMockEndpoint,
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
