import { expect, test } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  uniqueName,
  messagesView,
  getRagEmbedded,
  enableFileSearch,
  resetProvisioning,
  selectMockEndpoint,
  uploadViaUnifiedButton,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * A unified attachment is embedded on its first search from a temp copy named
 * `provision-<file_id>-<uuid>`, which the RAG API stores as the chunk's source. The
 * result must still carry the attachment's own name and link to it (#17313).
 */
test.describe('file_search result names', () => {
  test('a lazily embedded attachment is named after the file in the search results @scenario:file-search-names-provisioned-file', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    await resetProvisioning(page);
    await enableFileSearch(page);

    const fileName = `${uniqueName('contract')}.csv`;
    const response = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/csv',
      content: 'clause,notice\ntermination,30 days\n',
    });
    expect(response.ok()).toBeTruthy();
    const fileId = ((await response.json()) as UploadedFile).file_id;
    await expect(
      page.getByTestId('composer-tray').getByRole('button', { name: fileName }),
    ).toBeVisible({ timeout: 15000 });

    await sendMessageAndWaitForCompletion(page, `E2E_FILE_SEARCH:${uniqueName('rag-hit')}`);
    const embed = (await getRagEmbedded(page)).find((entry) => entry.file_id === fileId);
    expect(embed?.filename, 'the file is embedded from its temp copy').toMatch(/^provision-/);

    const view = messagesView(page);
    await view.getByRole('button', { name: /searched your files/i }).click();
    await expect(view.getByRole('button', { name: `Preview: ${fileName}` })).toBeVisible();
    await expect(view.getByText(/provision-/)).toHaveCount(0);
  });
});
