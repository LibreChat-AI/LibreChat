import { expect, test } from '@playwright/test';
import type { UploadedTextFile } from './documents.helpers';
import {
  DOCX_MIME,
  documentFixture,
  openExtractedText,
  openUnifiedComposer,
  uploadViaUnifiedButton,
} from './documents.helpers';

/**
 * The feature's primary outcome: on a deployment with no OCR service configured, a
 * Word document attached in the composer is parsed locally at upload time and the user
 * can read exactly what the model will receive.
 */
test('an attached Word document offers the text the server extracted @scenario:parsed-docx-offers-its-text', async ({
  page,
}) => {
  test.setTimeout(180000);
  await openUnifiedComposer(page);

  const upload = documentFixture('structured.docx');
  const response = await uploadViaUnifiedButton(page, upload);

  expect(response.status(), await response.text()).toBe(200);
  const stored = (await response.json()) as UploadedTextFile;
  /* Storage keeps the original document, so the record says "delivered as text"
   * through llmDeliveryPath rather than through its storage source. */
  expect(stored.llmDeliveryPath).toBe('text');
  expect(stored.type).toBe(DOCX_MIME);
  /** Markdown structure, not a flat dump: the table survives the conversion. */
  expect(stored.text).toContain('# Quarterly Report');
  expect(stored.text).toContain('| Region | Units | Revenue |');

  const region = await openExtractedText(page, upload.name);
  await expect(region).toContainText('Quarterly Report');
  await expect(region).toContainText('Revenue');
});
