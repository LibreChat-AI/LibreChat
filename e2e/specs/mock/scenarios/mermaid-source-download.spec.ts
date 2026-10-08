import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { escapeRegExp } from '../helpers';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const CACHED_DIAGRAM = `flowchart LR
  A[Start] --> B[Middle]`;
const STORED_DIAGRAM = `flowchart LR\n  A[Start] --> B[Middle]\n  B --> Z[StoredOnly]\n`;
const FAILURE_MESSAGE = 'Could not export this diagram. Please try again.';
const SUCCESS_MESSAGE = 'Diagram download started.';
const DOWNLOAD_ERROR_MESSAGE = 'Error downloading file. The file may have been deleted.';

async function installFixture(page: Page, fail: boolean) {
  const conversationId = `e2e-mermaid-source-${randomUUID()}`;
  const messageId = `${conversationId}-message`;
  const fileId = `${conversationId}-file`;
  const downloadUser = getE2EUser().email;
  const filename = 'flow.mmd';
  const attachment = {
    file_id: fileId,
    filename,
    filepath: `/uploads/${downloadUser}/${fileId}__${filename}`,
    type: 'execute_code',
    source: 'local',
    user: downloadUser,
    text: CACHED_DIAGRAM,
    bytes: Buffer.byteLength(STORED_DIAGRAM),
    messageId,
    conversationId,
    toolCallId: `${conversationId}-tool-call`,
  };
  const now = new Date().toISOString();
  const conversation = {
    conversationId,
    title: 'Mermaid source download fixture',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const message = {
    messageId,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content: [
      {
        type: 'tool_call',
        tool_call: {
          id: attachment.toolCallId,
          name: 'execute_code',
          args: '{"lang":"mermaid","code":"flowchart LR"}',
          output: 'generated flow.mmd',
          progress: 1,
        },
      },
    ],
    attachments: [attachment],
    createdAt: now,
    updatedAt: now,
  };
  const conversationRe = escapeRegExp(conversationId);
  const downloadRe = new RegExp(
    `/api/files/download/${escapeRegExp(downloadUser)}/${escapeRegExp(fileId)}(?:\\?.*)?$`,
  );

  await page.route(new RegExp(`/api/convos/${conversationRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${conversationRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([message]),
    }),
  );
  await page.route(downloadRe, (route: Route) =>
    fail
      ? route.fulfill({ status: 500, contentType: 'text/plain', body: 'stored file unavailable' })
      : route.fulfill({
          status: 200,
          contentType: 'text/plain',
          body: STORED_DIAGRAM,
        }),
  );

  return conversationId;
}

async function openSourceMenu(page: Page, conversationId: string) {
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
  const messages = page.getByTestId('messages-view');
  const artifactButton = messages.getByRole('button', {
    name: 'Open as artifact',
    exact: true,
  });
  await expect(artifactButton).toBeVisible({ timeout: 30000 });
  await artifactButton.click();

  const panel = page.locator('#artifact-viewer');
  await expect(panel).toBeVisible();
  const exportButton = panel.getByRole('button', { name: 'Export diagram', exact: true });
  await exportButton.click();
  const sourceItem = page.getByRole('menuitem', { name: 'Download source', exact: true });
  await expect(sourceItem).toBeEnabled();
  return { panel, sourceItem };
}

test.describe('Mermaid source downloads', () => {
  test(
    'saves the complete stored Mermaid file rather than cached text ' +
      '@scenario:mermaid-source-download-saves-the-stored-file',
    async ({ page }) => {
      const conversationId = await installFixture(page, false);
      const { panel, sourceItem } = await openSourceMenu(page, conversationId);

      const [download] = await Promise.all([page.waitForEvent('download'), sourceItem.click()]);
      expect(download.suggestedFilename()).toBe('flow.mmd');
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const source = Buffer.concat(chunks).toString('utf8');
      expect(source).toContain('Z[StoredOnly]');
      await expect(panel.getByRole('status')).toHaveText(SUCCESS_MESSAGE);
    },
  );

  test(
    'announces when the stored Mermaid source cannot be downloaded ' +
      '@scenario:mermaid-source-download-failure-is-announced',
    async ({ page }) => {
      const conversationId = await installFixture(page, true);
      const { panel, sourceItem } = await openSourceMenu(page, conversationId);

      await sourceItem.click();
      const status = panel.getByRole('status');
      await expect(status).toHaveText(FAILURE_MESSAGE);
      await expect(status).not.toHaveText(SUCCESS_MESSAGE);
      /* One press, one toast: the download layer names the cause in the
       * notification, and the menu's live region carries the export's own
       * failure phrase. */
      const toasts = page.getByRole('region', { name: /Notifications/ });
      await expect(toasts.getByText(DOWNLOAD_ERROR_MESSAGE, { exact: true })).toHaveCount(1);
      await expect(toasts.getByText(FAILURE_MESSAGE, { exact: true })).toHaveCount(0);
    },
  );

  test(
    'the opened diagram row carries its filename and download once ' +
      '@scenario:file-backed-mermaid-row-owns-its-filename-and-download',
    async ({ page }) => {
      const conversationId = await installFixture(page, false);
      await page.goto(`/c/${conversationId}`, { timeout: 30000 });

      const messages = page.getByTestId('messages-view');
      const openButton = messages.getByRole('button', { name: 'Open as artifact', exact: true });
      await expect(openButton).toBeVisible({ timeout: 30000 });
      /* Before opening, the wrapper header is the only place the filename
       * and its download live. */
      await expect(messages.getByRole('button', { name: 'Download flow.mmd' })).toHaveCount(1);
      await openButton.click();

      /* A file-backed diagram's trigger carries the attachment's artifact
       * id, not the `mermaid-artifact-` id a model-authored fence gets. */
      const row = messages.locator('[data-artifact-trigger]');
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAccessibleName(/flow\.mmd Diagram/);
      /* The row replaced the wrapper header rather than stacking on top of
       * it: one filename, one download, both inside the row. */
      await expect(messages.getByText('flow.mmd', { exact: true })).toHaveCount(1);
      const download = messages.getByRole('button', { name: 'Download flow.mmd' });
      await expect(download).toHaveCount(1);
      const rowBox = await row.boundingBox();
      const downloadBox = await download.boundingBox();
      expect(rowBox).not.toBeNull();
      expect(downloadBox).not.toBeNull();
      expect(downloadBox!.y).toBeGreaterThanOrEqual(rowBox!.y - 1);
      expect(downloadBox!.y + downloadBox!.height).toBeLessThanOrEqual(
        rowBox!.y + rowBox!.height + 1,
      );

      /* On a phone the artifact opens as a sheet over the message list, so
       * dismiss the panel with its own close control before reaching the
       * row's download; the trigger stays a row once opened. */
      await page.locator('#artifact-viewer').getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('#artifact-viewer')).toBeHidden();
      await expect(row).toHaveAttribute('aria-expanded', 'false');
      await expect(messages.getByText('flow.mmd', { exact: true })).toHaveCount(1);
      await expect(download).toHaveCount(1);

      const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
      expect(file.suggestedFilename()).toBe('flow.mmd');
    },
  );
});
