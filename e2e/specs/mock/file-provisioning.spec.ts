import { expect, test } from '@playwright/test';
import type { UploadedFile } from './helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  uniqueName,
  sendMessage,
  getRagEmbedded,
  enableFileSearch,
  selectMockEndpoint,
  resetProvisioning,
  enableCodeInterpreter,
  uploadViaLegacyOption,
  uploadViaUnifiedButton,
  getCodeProvisionedUploads,
} from './helpers';

/**
 * File provisioning to the code env + vector DB (PR #12626), exercised against the
 * local fake code/RAG servers wired in e2e/playwright.config.mock.ts.
 *
 * Two trigger points are covered end to end (real backend + DB + provisioning HTTP):
 *
 * - Immediate (legacy dropdown, Mock Provider A): choosing "Upload to Code
 *   Environment" / "Upload for File Search" provisions at upload time
 *   (`uploadCodeEnvFile` / `uploadVectors`).
 * - Lazy (unified button, Mock Provider B): a plain attachment routes to `none` and
 *   is NOT provisioned at upload; it is uploaded to the code env / embedded only
 *   when a tool that needs it runs (`provisionFiles` at ON_TOOL_EXECUTE). This is the
 *   headline behavior — "all uploaded files available to the tool at execute time".
 *
 * The fake servers record every request, so each test asserts the file's bytes
 * actually reached the target env, independent of the deferred DB write.
 */

test.describe('file provisioning — immediate (legacy dropdown)', () => {
  test('"Upload to Code Environment" provisions the file to the code env', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await resetProvisioning(page);
    // The legacy "Upload to Code Environment" option only appears once the
    // ephemeral execute_code capability is enabled.
    await enableCodeInterpreter(page);

    const fileName = `${uniqueName('code')}.csv`;
    const response = await uploadViaLegacyOption(page, 'Upload to Code Environment', {
      name: fileName,
      mimeType: 'text/csv',
      content: 'x,y\n1,2\n',
    });
    expect(response.ok()).toBeTruthy();

    // The upload reached the code env (fake server received it at upload time).
    await expect
      .poll(async () => (await getCodeProvisionedUploads(page)).map((u) => u.filename), {
        timeout: 15000,
      })
      .toContain(fileName);
  });

  test('"Upload for File Search" embeds the file into the vector DB', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await resetProvisioning(page);
    // The legacy "Upload for File Search" option only appears once the ephemeral
    // file_search capability is enabled.
    await enableFileSearch(page);

    const fileName = `${uniqueName('search')}.csv`;
    const response = await uploadViaLegacyOption(page, 'Upload for File Search', {
      name: fileName,
      mimeType: 'text/csv',
      content: 'a,b\n3,4\n',
    });
    expect(response.ok()).toBeTruthy();

    await expect
      .poll(async () => (await getRagEmbedded(page)).map((e) => e.filename), { timeout: 15000 })
      .toContain(fileName);
  });
});

test.describe('file provisioning — lazy (unified upload, at tool-execute)', () => {
  test('a unified attachment is provisioned to the code env when execute_code runs', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    await resetProvisioning(page);
    await enableCodeInterpreter(page);

    // Unified upload routes to `none`: stored, but NOT yet in the code env.
    const fileName = `${uniqueName('lazycode')}.csv`;
    const response = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/csv',
      content: 'name,score\nzoe,9\n',
    });
    expect(response.ok()).toBeTruthy();
    expect(
      (await getCodeProvisionedUploads(page)).map((u) => u.filename),
      'unified upload must not provision to the code env until a tool runs',
    ).not.toContain(fileName);
    await expect(page.getByRole('button', { name: fileName })).toBeVisible({ timeout: 15000 });

    // A tool run triggers lazy provisioning: the fake model emits an execute_code call.
    // Provisioning fires at ON_TOOL_EXECUTE, before the execute_code tool itself runs,
    // so assert it reached the code env independent of the tool's own result.
    await sendMessage(page, `E2E_EXECUTE_CODE:${uniqueName('run')}`);

    await expect
      .poll(async () => (await getCodeProvisionedUploads(page)).map((u) => u.filename), {
        timeout: 30000,
      })
      .toContain(fileName);
  });

  test('a unified attachment is embedded into the vector DB when file_search runs', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    await resetProvisioning(page);
    await enableFileSearch(page);

    const fileName = `${uniqueName('lazysearch')}.csv`;
    const response = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/csv',
      content: 'k,v\nfoo,bar\n',
    });
    expect(response.ok()).toBeTruthy();
    // uploadVectors streams from a temp path, so the fake RAG records the file_id,
    // not the original filename — correlate on the id from the upload response.
    const fileId = ((await response.json()) as UploadedFile).file_id;
    expect(fileId, 'upload response should include a file_id').toBeTruthy();
    expect(
      (await getRagEmbedded(page)).map((e) => e.file_id),
      'unified upload must not embed until file_search runs',
    ).not.toContain(fileId);
    await expect(page.getByRole('button', { name: fileName })).toBeVisible({ timeout: 15000 });

    // Embedding fires at ON_TOOL_EXECUTE, independent of the file_search tool result.
    await sendMessage(page, `E2E_FILE_SEARCH:${uniqueName('q')}`);

    await expect
      .poll(async () => (await getRagEmbedded(page)).map((e) => e.file_id), { timeout: 30000 })
      .toContain(fileId);
  });
});
