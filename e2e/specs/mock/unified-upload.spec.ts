import { expect, test } from '@playwright/test';
import type { UploadedFile } from './helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  uniqueName,
  fetchJson,
  isAgentsStream,
  getAccessToken,
  selectMockEndpoint,
  uploadViaUnifiedButton,
} from './helpers';

/**
 * Unified file upload — per-mime-type delivery routing (PR #12626).
 *
 * Runs against Mock Provider B, configured for unified mode in
 * e2e/config/librechat.e2e.yaml (Mock Provider A stays on the legacy dropdown
 * for chat.spec.ts's upload-to-provider test).
 *
 * What this proves end-to-end (real backend + DB), and what it deliberately can't:
 * - The composer renders ONE attach button (unified mode), not the legacy 3-way
 *   dropdown.
 * - A `none`-routed upload (csv) persists `llmDeliveryPath: 'none'` and is kept
 *   out of LLM delivery — reachable only by tools.
 * - A `provider`-routed upload (markdown) is STILL delivered to the model AND
 *   shown as an attachment chip — unified mode doesn't lose upload-to-provider.
 * - A `text`-routed upload (json) is extracted and persisted as `text`.
 *
 * The "available to the code interpreter / file_search at tool-execute time" half
 * lives in file-provisioning.spec.ts, which drives the fake code + RAG servers.
 *
 * `.xlsx` follows the identical `none` code path; csv/markdown/json are used so the
 * uploaded bytes match the declared mime type without synthesizing binaries.
 */

test.describe('unified file upload', () => {
  test('single attach button routes a csv to llmDeliveryPath "none"', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    // Default model needs a real key; Mock Provider B is the unified-mode endpoint.
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);

    // Unified mode: one attach button, and the legacy multi-option dropdown trigger
    // is not rendered at all.
    await expect(page.locator('#attach-file-button')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#attach-file-menu-button')).toHaveCount(0);

    // Upload-time routing: the configured override (csv -> none) must persist, so
    // the file is kept out of LLM delivery and left for tools (code interpreter).
    const fileName = `${uniqueName('data')}.csv`;
    const response = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/csv',
      content: 'name,score\nalice,1\nbob,2\n',
    });
    expect(response.ok()).toBeTruthy();

    const uploaded = (await response.json()) as UploadedFile;
    expect(uploaded.filename).toBe(fileName);
    expect(uploaded.llmDeliveryPath).toBe('none');

    // Persistence: the file is queryable from the backend with the same routing.
    const token = await getAccessToken(page);
    const files = await fetchJson<UploadedFile[]>(page, '/api/files', token);
    const persisted = files.find((f) => f.filename === fileName);
    expect(persisted, `uploaded file "${fileName}" should persist`).toBeTruthy();
    expect(persisted?.llmDeliveryPath).toBe('none');
  });

  test('single attach button still delivers a provider-routed upload and shows it in chat', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);

    // Same single unified button — no legacy dropdown.
    await expect(page.locator('#attach-file-button')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#attach-file-menu-button')).toHaveCount(0);

    // markdown is overridden to `provider` for Mock Provider B: it should be
    // delivered to the model (unlike `none`) while still attaching to the chat.
    const fileName = `${uniqueName('doc')}.md`;
    const response = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/markdown',
      content: '# E2E provider doc\n\nrouted to the provider via unified upload\n',
    });
    expect(response.ok()).toBeTruthy();
    expect(((await response.json()) as UploadedFile).llmDeliveryPath).toBe('provider');

    // (a) shows as an attachment chip in the composer before sending.
    await expect(page.getByRole('button', { name: fileName })).toBeVisible({ timeout: 15000 });

    // (b) reaches the model input: the mock LLM echoes a pass marker only when the
    // provider file is present in the request content (see e2e/setup/fake-model.js).
    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.fill(`E2E_ASSERT_PROVIDER_FILE:${fileName}`);
    const [stream] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      page.getByTestId('send-button').click(),
    ]);
    expect(stream.ok()).toBeTruthy();

    await expect(
      page
        .getByTestId('messages-view')
        .getByText(`E2E provider file assertion passed: ${fileName}`),
    ).toBeVisible({ timeout: 20000 });

    // chip persists on the sent message.
    await expect(
      page.getByTestId('messages-view').getByRole('button', { name: fileName }),
    ).toBeVisible();
  });

  test('single attach button routes a json upload to llmDeliveryPath "text"', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);

    await expect(page.locator('#attach-file-button')).toBeVisible({ timeout: 15000 });

    // application/json is neither overridden nor image/pdf, so it falls through to the
    // system fallback ('text'): extracted and delivered as text context, not a provider file.
    const fileName = `${uniqueName('notes')}.json`;
    const response = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'application/json',
      content: '{"e2e":"unified text routing","rows":[1,2,3]}\n',
    });
    expect(response.ok()).toBeTruthy();

    const token = await getAccessToken(page);
    const files = await fetchJson<UploadedFile[]>(page, '/api/files', token);
    const persisted = files.find((f) => f.filename === fileName);
    expect(persisted, `uploaded file "${fileName}" should persist`).toBeTruthy();
    expect(persisted?.llmDeliveryPath).toBe('text');
  });

  test('legacy endpoint renders the 3-way upload dropdown, not the single button', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    // Mock Provider A opts into legacyFileUploadUX.
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    // Legacy: the menu-button trigger is present; the unified single button is not.
    await expect(page.locator('#attach-file-menu-button')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#attach-file-button')).toHaveCount(0);

    // Opening it reveals the classic multi-option menu (its always-present entry is
    // the provider upload; the code/file_search options are gated on those ephemeral
    // capabilities being enabled first).
    await page.locator('#attach-file-menu-button').click();
    await expect(page.getByText('Upload to Provider')).toBeVisible();
  });
});
