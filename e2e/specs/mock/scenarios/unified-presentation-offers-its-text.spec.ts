import { expect, test } from '@playwright/test';
import type { UploadedTextFile } from './documents.helpers';
import {
  documentFixture,
  openExtractedText,
  openUnifiedComposer,
  uploadViaUnifiedButton,
} from './documents.helpers';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Unified mode names no tool resource, so the delivery-path default alone decides whether
 * a document reaches the parser. Every format the parser reads has to be routed there:
 * a presentation that is admitted but never extracted is stored as bytes nothing can
 * use, and a permanent agent upload of one is refused outright for having no consumer.
 */
test('an attached presentation offers the text the server extracted @scenario:unified-presentation-offers-its-text', async ({
  page,
}) => {
  test.setTimeout(180000);
  await openUnifiedComposer(page);

  const upload = documentFixture('deck.pptx', { mimeType: PPTX_MIME });
  const response = await uploadViaUnifiedButton(page, upload);

  expect(response.status(), await response.text()).toBe(200);
  const stored = (await response.json()) as UploadedTextFile;
  expect(stored.llmDeliveryPath).toBe('text');
  expect(stored.type).toBe(PPTX_MIME);
  expect(stored.text).toContain('Quarterly Highlights');

  const region = await openExtractedText(page, upload.name);
  await expect(region).toContainText('Quarterly Highlights');
});
