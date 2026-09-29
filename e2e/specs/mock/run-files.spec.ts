import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { FileContext } from 'librechat-data-provider';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  CODE_API_BASE,
  MOCK_ENDPOINTS,
  fetchJson,
  uniqueName,
  messagesView,
  requestJson,
  getAccessToken,
  getRagEmbedded,
  resetProvisioning,
  uploadViaUnifiedButton,
  getCodeProvisionedUploads,
  sendMessageAndWaitForCompletion,
} from './helpers';

function inputPdf(): string {
  const content = 'BT /F1 12 Tf 72 720 Td (Run file sharing input) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
}

async function createAgent(
  page: Page,
  token: string,
  name: string,
  fields: Pick<AgentDetail, 'tools' | 'subagents'>,
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Run-scoped file sharing integration fixture.',
      instructions: 'Follow the test request exactly.',
      provider: MOCK_ENDPOINTS[1].label,
      model: MOCK_ENDPOINTS[1].model,
      ...fields,
    },
  });
}

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

test.describe('run-scoped subagent files', () => {
  test('shares an uploaded PDF lazily and keeps the published CSV usable after reload', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = uniqueName('publication');
    const inputName = `e2e-run-files-${label}.pdf`;
    const outputName = `e2e-run-files-${label}.csv`;
    const parentName = uniqueAgentName('E2E File Parent');
    let childId: string | undefined;
    let parentId: string | undefined;
    const cleanupFiles: TFile[] = [];

    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const child = await createAgent(page, token, uniqueAgentName('E2E File Child'), {
        tools: ['file_search', 'execute_code'],
      });
      childId = child.id;
      const parent = await createAgent(page, token, parentName, {
        subagents: {
          enabled: true,
          allowSelf: false,
          shareFiles: true,
          agent_ids: [child.id],
        },
      });
      parentId = parent.id;
      await selectAgent(page, parentName);
      await resetProvisioning(page);

      const upload = await uploadViaUnifiedButton(page, {
        name: inputName,
        mimeType: 'application/pdf',
        content: inputPdf(),
      });
      expect(upload.ok()).toBeTruthy();
      const input = (await upload.json()) as TFile;
      cleanupFiles.push(input);
      expect(input.file_id).toBeTruthy();
      expect((await getRagEmbedded(page)).map((file) => file.file_id)).not.toContain(input.file_id);
      expect((await getCodeProvisionedUploads(page)).map((file) => file.filename)).not.toContain(
        inputName,
      );

      const admission = await sendMessageAndWaitForCompletion(
        page,
        `E2E_RUN_FILES:${child.id}:${label}`,
        { timeout: 90_000 },
      );
      const { conversationId } = (await admission.json()) as { conversationId: string };
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
        timeout: 30_000,
      });
      await expect(messagesView(page)).toContainText(`E2E run files complete ${label} file=`);
      await expect
        .poll(async () => (await getRagEmbedded(page)).map((file) => file.file_id))
        .toContain(input.file_id);
      await expect
        .poll(async () => (await getCodeProvisionedUploads(page)).map((file) => file.filename))
        .toContain(inputName);

      const files = await fetchJson<TFile[]>(page, '/api/files', token);
      const published = files.find(
        (file) => file.filename === outputName && file.context === FileContext.run_artifact,
      );
      expect(published, 'publication must create a durable conversation file').toBeDefined();
      if (!published) throw new Error('Published CSV missing from durable files');
      cleanupFiles.push(published);
      expect(published.conversationId).toBe(conversationId);
      expect(published.metadata?.runFile).toMatchObject({
        agentId: child.id,
        inputFileIds: expect.arrayContaining([input.file_id]),
      });
      expect(published.metadata?.runFile?.executionId).toBeTruthy();
      expect(published.metadata?.runFile?.parentExecutionId).toBeTruthy();
      await expect(messagesView(page)).toContainText(
        `E2E run files complete ${label} file=${published.file_id}`,
      );

      const messages = await fetchJson<TMessage[]>(
        page,
        `/api/messages/${encodeURIComponent(conversationId)}`,
        token,
      );
      expect(
        messages.some((message) =>
          message.attachments?.some((attachment) =>
            'file_id' in attachment ? attachment.file_id === published.file_id : false,
          ),
        ),
      ).toBe(true);

      await page.reload();
      const downloadButton = messagesView(page).getByRole('button', {
        name: `Download ${outputName}`,
        exact: true,
      });
      await expect(downloadButton).toBeVisible({ timeout: 30_000 });
      const downloadPromise = page.waitForEvent('download');
      await downloadButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(outputName);
      expect(await download.failure()).toBeNull();

      await page.getByTestId('nav-panel-files').click();
      const filesPanel = page.getByRole('region', { name: 'Files Table' });
      await filesPanel.locator('#filename-filter').fill(outputName);
      const reuse = filesPanel.locator('td[role="button"]').filter({ hasText: outputName });
      await expect(reuse).toHaveCount(1);
      await reuse.press('Enter');
      await expect(
        page.getByTestId('composer-surface').getByRole('button', { name: outputName, exact: true }),
      ).toBeVisible();

      await sendMessageAndWaitForCompletion(
        page,
        `E2E_RUN_FILES_FOLLOWUP:${label}:${published.file_id}`,
        { timeout: 45_000 },
      );
      await expect(messagesView(page)).toContainText(`E2E run file followup ${published.file_id}`);
    } finally {
      if (cleanupFiles.length > 0) {
        await requestJson(page, {
          path: '/api/files',
          token: await getAccessToken(page),
          method: 'DELETE',
          body: { files: cleanupFiles },
        });
      }
      await cleanupAgent(page, parentId);
      await cleanupAgent(page, childId);
    }
  });

  test('retains private versions across inspection and overwrite and downloads both after reload', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = uniqueName('versions');
    const pdfName = `e2e-run-file-versions-${label}.pdf`;
    const csvName = `e2e-run-file-versions-${label}.csv`;
    const outputName = 'analysis.csv';
    const expectedFirst = 'version,total\n1,30\n';
    const expectedSecond = 'version,total\n2,35\n';
    const parentName = uniqueAgentName('E2E Version Parent');
    let childId: string | undefined;
    let parentId: string | undefined;
    const cleanupFiles: TFile[] = [];

    try {
      await page.goto('/c/new');
      const token = await getAccessToken(page);
      const child = await createAgent(page, token, uniqueAgentName('E2E Version Child'), {
        tools: ['file_search', 'execute_code'],
      });
      childId = child.id;
      const parent = await createAgent(page, token, parentName, {
        subagents: {
          enabled: true,
          allowSelf: false,
          shareFiles: true,
          agent_ids: [child.id],
        },
      });
      parentId = parent.id;
      await selectAgent(page, parentName);
      await resetProvisioning(page);

      for (const fixture of [
        { name: pdfName, mimeType: 'application/pdf', content: inputPdf() },
        { name: csvName, mimeType: 'text/csv', content: 'item,amount\nfirst,10\nsecond,20\n' },
      ]) {
        const upload = await uploadViaUnifiedButton(page, fixture);
        expect(upload.ok()).toBeTruthy();
        cleanupFiles.push((await upload.json()) as TFile);
      }
      const inputIds = cleanupFiles.map((file) => file.file_id);
      const admission = await sendMessageAndWaitForCompletion(
        page,
        `E2E_RUN_FILE_VERSIONS:${child.id}:${label}`,
        { timeout: 120_000 },
      );
      const { conversationId } = (await admission.json()) as { conversationId: string };
      await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
        timeout: 30_000,
      });
      await expect(messagesView(page)).toContainText(`E2E run file versions complete ${label}`);
      const proof = (await messagesView(page).innerText()).match(
        new RegExp(
          `E2E run file versions complete ${label} v1=([\\w.:-]+) v2=([\\w.:-]+) artifact_v1=([\\w.:-]+) artifact_v2=([\\w.:-]+)`,
        ),
      );
      expect(proof, 'parent must confirm both catalog references').not.toBeNull();
      if (!proof) throw new Error('Version publication proof missing');
      const [, firstFileId, secondFileId, firstArtifactId, secondArtifactId] = proof;
      expect(firstFileId).not.toBe(secondFileId);
      expect(firstArtifactId).not.toBe(secondArtifactId);

      const files = await fetchJson<TFile[]>(page, '/api/files', token);
      const published = files.filter(
        (file) =>
          file.conversationId === conversationId && file.context === FileContext.run_artifact,
      );
      cleanupFiles.push(...published);
      expect(published.map((file) => file.file_id).sort()).toEqual(
        [firstFileId, secondFileId].sort(),
      );
      const messages = await fetchJson<TMessage[]>(
        page,
        `/api/messages/${encodeURIComponent(conversationId)}`,
        token,
      );
      for (const file of published) {
        expect(file.filename).toBe(outputName);
        expect(file.metadata?.runFile).toMatchObject({
          agentId: child.id,
          parentAgentId: parent.id,
          inputFileIds: expect.arrayContaining(inputIds),
        });
        expect(file.metadata?.runFile?.executionId).toBeTruthy();
        expect(
          messages.some((message) =>
            message.attachments?.some((attachment) =>
              'file_id' in attachment ? attachment.file_id === file.file_id : false,
            ),
          ),
        ).toBe(true);
      }
      expect((await getRagEmbedded(page)).map((file) => file.file_id)).toContain(inputIds[0]);
      expect((await getCodeProvisionedUploads(page)).map((file) => file.filename)).toEqual(
        expect.arrayContaining([pdfName, csvName]),
      );
      const overwrittenSource = await page.request.get(
        `${CODE_API_BASE}/v1/download/e2e-run-file-versions-${label}/e2e-versioned-${label}`,
      );
      expect(overwrittenSource.ok()).toBeTruthy();
      expect(await overwrittenSource.text()).toBe(expectedSecond);

      await page.reload();
      const downloadButtons = messagesView(page).getByRole('button', {
        name: `Download ${outputName}`,
        exact: true,
      });
      await expect(downloadButtons).toHaveCount(2, { timeout: 30_000 });
      const expectedIds = new Set([firstFileId, secondFileId]);
      const downloaded = new Map<string, string>();
      for (let index = 0; index < 2; index++) {
        const downloadPromise = page.waitForEvent('download');
        const responsePromise = page.waitForResponse((response) => {
          const pathname = new URL(response.url()).pathname;
          return (
            response.request().method() === 'GET' &&
            pathname.startsWith('/api/files/download/') &&
            expectedIds.has(decodeURIComponent(pathname.split('/').pop() ?? ''))
          );
        });
        await downloadButtons.nth(index).click();
        const [download, response] = await Promise.all([downloadPromise, responsePromise]);
        expect(response.ok()).toBeTruthy();
        expect(download.suggestedFilename()).toBe(outputName);
        expect(await download.failure()).toBeNull();
        const fileId = decodeURIComponent(new URL(response.url()).pathname.split('/').pop() ?? '');
        downloaded.set(fileId, await readFile(await download.path(), 'utf8'));
      }
      expect(downloaded.size).toBe(2);
      expect(downloaded.get(firstFileId)).toBe(expectedFirst);
      expect(downloaded.get(secondFileId)).toBe(expectedSecond);
    } finally {
      if (cleanupFiles.length > 0) {
        await requestJson(page, {
          path: '/api/files',
          token: await getAccessToken(page),
          method: 'DELETE',
          body: { files: cleanupFiles },
        });
      }
      await cleanupAgent(page, parentId);
      await cleanupAgent(page, childId);
    }
  });
});
