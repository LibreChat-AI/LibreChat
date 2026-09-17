import { expect, test } from '@playwright/test';
import { DOCX_MIME, openLegacyComposer, uploadAsText } from './documents.helpers';

/**
 * The parser reads the whole document into memory, so an input above its 15MB ceiling is
 * refused before any engine is handed the bytes — and refused as "too large" (413), not
 * as a server error the user cannot act on.
 */
test('a document above the parser size limit is refused as too large @scenario:oversized-document-refused-as-too-large', async ({
  page,
}) => {
  test.setTimeout(180000);
  await openLegacyComposer(page);

  const response = await uploadAsText(page, {
    name: `oversized-${Date.now()}.docx`,
    mimeType: DOCX_MIME,
    /** One byte past the 15MB parser input cap; the endpoint's own size limit is higher. */
    buffer: Buffer.alloc(15 * 1024 * 1024 + 1, 0x41),
  });

  expect(response.status()).toBe(413);
  const body = (await response.json()) as { message?: string };
  expect(body.message).toContain('15MB document parser limit');

  await expect(page.getByText(/document parser limit/i).first()).toBeVisible({ timeout: 20000 });
});
