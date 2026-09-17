import { expect, test } from '@playwright/test';
import { fetchJson, getAccessToken } from '../helpers';
import type { UploadedTextFile } from './documents.helpers';
import { documentFixture, openLegacyComposer, uploadAsText } from './documents.helpers';

/**
 * The failure the feature must not paper over: an image-only PDF has no text layer, so
 * with no OCR service configured the upload is refused and says why, instead of storing
 * the document's bytes decoded as text.
 */
test('an image-only PDF is refused with an OCR explanation and stores nothing @scenario:scanned-pdf-refused-without-ocr', async ({
  page,
}) => {
  test.setTimeout(180000);
  await openLegacyComposer(page);

  const upload = documentFixture('sample-scanned.pdf');
  const response = await uploadAsText(page, upload);

  expect(response.ok()).toBeFalsy();
  const body = (await response.json()) as { message?: string };
  expect(body.message).toContain('requires an OCR service');

  /** The user is told, rather than left with a silently missing attachment. */
  await expect(page.getByText(/requires an OCR service/i).first()).toBeVisible({
    timeout: 20000,
  });

  const token = await getAccessToken(page);
  const files = await fetchJson<UploadedTextFile[]>(page, '/api/files', token);
  expect(files.find((file) => file.filename === upload.name)).toBeUndefined();
});
