import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  waitForUpload,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * A PDF attached as text reaches the model as its extracted text, while its preview opens on
 * the stored original and offers the extracted text one click away.
 */

/** A one-page PDF whose only text is `text`, so the extracted text is known exactly. */
function pdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

/** Attaches `name` through the legacy "Upload as Text" choice and sends one turn with it. */
async function sendPdfAsText(page: Page, name: string, canary: string): Promise<UploadedFile> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const upload = waitForUpload(page);
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
  /** The legacy menu keeps the secondary upload choices behind a disclosure. */
  await palette.getByRole('button', { name: 'More upload options' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    palette.getByRole('button', { name: 'Upload as Text', exact: true }).click(),
  ]);
  await chooser.setFiles({ name, mimeType: 'application/pdf', buffer: pdf(canary) });
  const response = await upload;
  expect(response.ok()).toBeTruthy();
  const uploaded = (await response.json()) as UploadedFile;
  expect(uploaded.llmDeliveryPath).toBe('text');
  await expect(
    page.getByTestId('composer-tray').getByRole('button', { name, exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await sendMessageAndWaitForCompletion(page, 'Read the attached report.');
  return uploaded;
}

async function openPreview(page: Page, name: string) {
  await messagesView(page).getByRole('button', { name, exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a text-delivered PDF previews its original and its extracted text @scenario:text-delivered-pdf-previews-original-and-extracted-text', async ({
  page,
}) => {
  test.setTimeout(120000);
  const canary = `E2E-original-preview-${randomUUID()}`;
  const name = `report-${randomUUID().slice(0, 8)}.pdf`;
  await sendPdfAsText(page, name, canary);

  const dialog = await openPreview(page, name);
  const views = dialog.getByRole('radiogroup', { name: 'Preview view' });
  await expect(views.getByRole('radio', { name: 'Original' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog.locator(`iframe[title="Preview: ${name}"]`)).toBeVisible({
    timeout: 15000,
  });
  await expect(dialog.getByText(canary)).toHaveCount(0);

  await views.getByRole('radio', { name: 'Extracted text' }).click();
  await expect(dialog.getByText(canary)).toBeVisible({ timeout: 15000 });
  await expect(dialog.locator('iframe')).toHaveCount(0);

  /** The button names what it saves: the stored PDF, whichever view is open. */
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: `Download original ${name}` }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(name);
  const path = await download.path();
  expect((await readFile(path)).subarray(0, 5).toString()).toBe('%PDF-');

  await views.getByRole('radio', { name: 'Original' }).click();
  await expect(dialog.locator(`iframe[title="Preview: ${name}"]`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  /** Viewing either representation leaves the model's input as the extracted text. */
  await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${canary}`);
  await expect(
    messagesView(page).getByText(`E2E history assertion present: ${canary}`),
  ).toBeVisible({ timeout: 30000 });
});

test('a text-delivered PDF whose original cannot be read previews its extracted text @scenario:missing-pdf-original-falls-back-to-extracted-text', async ({
  page,
}) => {
  test.setTimeout(120000);
  const canary = `E2E-missing-original-${randomUUID()}`;
  const name = `missing-${randomUUID().slice(0, 8)}.pdf`;
  const uploaded = await sendPdfAsText(page, name, canary);

  /** The stored object is gone: the download route answers as it does for a deleted file. */
  await page.route(`**/api/files/download/*/${uploaded.file_id}*`, (route) =>
    route.fulfill({ status: 404, body: 'File not found' }),
  );
  const dialog = await openPreview(page, name);
  await expect(dialog.getByText(canary)).toBeVisible({ timeout: 15000 });
  await expect(dialog.getByRole('radiogroup')).toHaveCount(0);
  await expect(dialog.locator('iframe')).toHaveCount(0);
  await expect(dialog.getByText('Preview not available for this file type')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: `Download ${name}` })).toBeVisible();
});
