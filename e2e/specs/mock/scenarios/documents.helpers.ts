import fs from 'fs';
import path from 'path';
import { expect } from '@playwright/test';
import type { Locator, Page, Response } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint, waitForUpload } from '../helpers';

/**
 * Acceptance scenarios for local document extraction (AnyDoc + pdf-inspector).
 *
 * The uploads use the same fixtures the server-side parser unit tests read, so the
 * browser path exercises the real engines on the real bytes: no OCR service is
 * configured in `e2e/config/librechat.e2e.yaml`, which is the deployment shape these
 * scenarios are about.
 */
const FIXTURE_DIR = path.resolve(__dirname, '../../../../packages/api/src/files/documents');

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_MIME = 'application/pdf';
/** A client that types uploads by magic bytes reports an OOXML document as a zip. */
export const ZIP_MIME = 'application/zip';

export type DocumentUpload = { name: string; mimeType: string; buffer: Buffer };

/** Unique per run so repeated scenario runs never collide on a filename. */
const unique = (name: string) => {
  const ext = path.extname(name);
  return `${path.basename(name, ext)}-${Date.now()}-${Math.floor(Math.random() * 1e4)}${ext}`;
};

export function documentFixture(file: string, options: { mimeType?: string } = {}): DocumentUpload {
  return {
    name: unique(file),
    mimeType: options.mimeType ?? (file.endsWith('.pdf') ? PDF_MIME : DOCX_MIME),
    buffer: fs.readFileSync(path.join(FIXTURE_DIR, file)),
  };
}

/** Mock Provider B presents the unified single attach button, which routes by MIME type. */
export async function openUnifiedComposer(page: Page): Promise<void> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
  await expect(page.locator('#attach-file-button')).toBeVisible({ timeout: 15000 });
}

/** Mock Provider A keeps the explicit destination chooser, where "Upload as Text" is context. */
export async function openLegacyComposer(page: Page): Promise<void> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await expect(page.locator('#attach-file-menu-button')).toBeVisible({ timeout: 15000 });
}

export async function uploadViaUnifiedButton(
  page: Page,
  upload: DocumentUpload,
): Promise<Response> {
  const uploadResponse = waitForUpload(page);
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#attach-file-button').click(),
  ]);
  await fileChooser.setFiles(upload);
  return uploadResponse;
}

/** Attaches through the legacy chooser's context destination ("Upload as Text"). */
export async function uploadAsText(page: Page, upload: DocumentUpload): Promise<Response> {
  const uploadResponse = waitForUpload(page);
  await page.locator('#attach-file-menu-button').click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: 'Upload as Text' }).click(),
  ]);
  await fileChooser.setFiles(upload);
  return uploadResponse;
}

export type UploadedTextFile = {
  file_id?: string;
  filename?: string;
  type?: string;
  source?: string;
  text?: string;
  llmDeliveryPath?: string;
};

/** Opens the composer chip's extracted-text dialog and returns its text region. */
export async function openExtractedText(page: Page, filename: string): Promise<Locator> {
  const chip = page.getByRole('button', { name: `View text extracted from ${filename}` });
  await expect(chip).toBeVisible({ timeout: 20000 });
  await chip.click();
  const region = page.getByRole('region', { name: 'Extracted text' });
  await expect(region).toBeVisible({ timeout: 20000 });
  return region;
}
