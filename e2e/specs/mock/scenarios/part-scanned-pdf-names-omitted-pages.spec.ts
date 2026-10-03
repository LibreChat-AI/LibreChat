import { expect, test } from '@playwright/test';
import type { UploadedTextFile } from './documents.helpers';
import { documentFixture, openLegacyComposer, uploadAsText } from './documents.helpers';

/**
 * The partial case: one page carries text, another is a scan. The upload succeeds with
 * what could be read, and the stored text names the page that was left out so neither
 * the user nor the model treats an incomplete document as complete.
 */
test('a part-scanned PDF keeps its text and names the omitted page @scenario:part-scanned-pdf-names-omitted-pages', async ({
  page,
}) => {
  test.setTimeout(180000);
  await openLegacyComposer(page);

  const upload = documentFixture('sample-mixed.pdf');
  const response = await uploadAsText(page, upload);

  expect(response.status(), await response.text()).toBe(200);
  const stored = (await response.json()) as UploadedTextFile;
  expect(stored.llmDeliveryPath).toBe('text');
  expect(stored.text).toContain('Quarterly Report');
  expect(stored.text).toContain('Page 2 of this document contains no extractable text');
  expect(stored.text).toContain('requires an OCR service to read');
});
