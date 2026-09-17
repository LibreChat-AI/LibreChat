import { expect, test } from '@playwright/test';
import type { UploadedTextFile } from './documents.helpers';
import {
  DOCX_MIME,
  ZIP_MIME,
  documentFixture,
  openExtractedText,
  openUnifiedComposer,
  uploadViaUnifiedButton,
} from './documents.helpers';

/**
 * OOXML documents are zip containers, so a client that types uploads by magic bytes
 * offers a `.docx` as `application/zip`. The upload is still parsed as the document it
 * is rather than refused as an archive, and the stored record keeps the document type.
 */
test('a Word document a client typed as a zip archive is still parsed @scenario:zip-typed-docx-still-parses', async ({
  page,
}) => {
  test.setTimeout(180000);
  await openUnifiedComposer(page);

  const upload = documentFixture('structured.docx', { mimeType: ZIP_MIME });
  const response = await uploadViaUnifiedButton(page, upload);

  expect(response.status(), await response.text()).toBe(200);
  const stored = (await response.json()) as UploadedTextFile;
  expect(stored.llmDeliveryPath).toBe('text');
  expect(stored.type).toBe(DOCX_MIME);
  expect(stored.text).toContain('# Quarterly Report');

  const region = await openExtractedText(page, upload.name);
  await expect(region).toContainText('Quarterly Report');
});
