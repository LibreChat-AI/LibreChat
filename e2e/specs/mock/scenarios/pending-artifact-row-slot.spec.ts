import { expect, test } from '@playwright/test';
import type { Route } from '@playwright/test';

const NO_PARENT = '00000000-0000-0000-0000-000000000000';

const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test.describe('pending artifact row ordering', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll();
  });

  test('keeps a pending artifact preview in its row slot @scenario:pending-artifact-preview-keeps-its-row-slot', async ({
    page,
  }) => {
    test.setTimeout(60000);

    const conversationId = unique('e2e-pending-row-slot');
    const messageId = `${conversationId}-msg`;
    const pendingFileId = `${conversationId}-xlsx`;
    const resolvedFileId = `${conversationId}-html`;
    const now = new Date(0).toISOString();
    const pendingFilename = 'data.xlsx';
    const resolvedFilename = 'index.html';
    const toolCallId = `${conversationId}-tool`;

    const pendingAttachment = {
      file_id: pendingFileId,
      filename: pendingFilename,
      filepath: `/uploads/e2e/${pendingFileId}__${pendingFilename}`,
      type: 'execute_code',
      source: 'local',
      bytes: 2048,
      messageId,
      conversationId,
      toolCallId,
      status: 'pending',
      metadata: {
        codeEnvRef: { kind: 'user', id: 'e2e-user', storage_session_id: 'e2e-session' },
      },
    };
    const resolvedAttachment = {
      file_id: resolvedFileId,
      filename: resolvedFilename,
      filepath: `/uploads/e2e/${resolvedFileId}__${resolvedFilename}`,
      type: 'execute_code',
      source: 'local',
      bytes: 16,
      messageId,
      conversationId,
      toolCallId,
      status: 'ready',
      text: '<h1>hi</h1>',
      textFormat: 'html',
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
            id: toolCallId,
            name: 'execute_code',
            args: '{}',
            output: 'created files',
            progress: 1,
          },
        },
      ],
      attachments: [pendingAttachment, resolvedAttachment],
      createdAt: now,
      updatedAt: now,
    };
    const conversation = {
      conversationId,
      title: 'Pending artifact row slot',
      endpoint: 'Mock Provider A',
      endpointType: 'custom',
      model: 'mock-model-a',
      createdAt: now,
      updatedAt: now,
    };

    let previewRequests = 0;
    const convoIdRe = escapeRe(conversationId);
    const pendingFileIdRe = escapeRe(pendingFileId);
    await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(conversation),
      }),
    );
    await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([message]),
      }),
    );
    await page.route(
      new RegExp(`/api/files/${pendingFileIdRe}/preview(?:\\?.*)?$`),
      (route: Route) => {
        previewRequests += 1;
        const preview =
          previewRequests === 1
            ? { file_id: pendingFileId, status: 'pending' }
            : {
                file_id: pendingFileId,
                status: 'ready',
                text: '<table><tr><td>ready</td></tr></table>',
                textFormat: 'html',
              };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(preview),
        });
      },
    );

    await page.goto(`/c/${conversationId}`, { timeout: 30000 });

    const group = page.getByTestId('artifact-row-group');
    await expect(group).toBeVisible();
    const pendingTitle = group.getByText(pendingFilename, { exact: true });
    await expect(pendingTitle).toHaveAttribute('aria-busy', 'true', { timeout: 15000 });
    const initialPendingDownload = group.getByRole('button', {
      name: `Download ${pendingFilename}`,
      exact: true,
    });
    const initialResolvedDownload = group.getByRole('button', {
      name: `Download ${resolvedFilename}`,
      exact: true,
    });
    const initialPendingBox = await initialPendingDownload.boundingBox();
    const initialResolvedBox = await initialResolvedDownload.boundingBox();
    expect(initialPendingBox).not.toBeNull();
    expect(initialResolvedBox).not.toBeNull();
    expect(initialPendingBox!.y).toBeLessThan(initialResolvedBox!.y);

    const pendingArtifactRow = group.getByRole('button', {
      name: new RegExp(`^${escapeRe(pendingFilename)} Spreadsheet Opens as a rendered preview`),
    });
    await expect(pendingArtifactRow).toBeVisible({ timeout: 15000 });
    await expect(pendingTitle).not.toHaveAttribute('aria-busy', 'true');

    const resolvedArtifactRow = group.getByRole('button', {
      name: new RegExp(`^${escapeRe(resolvedFilename)} HTML Opens as a rendered preview`),
    });
    const finalPendingBox = await pendingArtifactRow.boundingBox();
    const finalResolvedBox = await resolvedArtifactRow.boundingBox();
    expect(finalPendingBox).not.toBeNull();
    expect(finalResolvedBox).not.toBeNull();
    expect(finalPendingBox!.y).toBeLessThan(finalResolvedBox!.y);
  });
});
