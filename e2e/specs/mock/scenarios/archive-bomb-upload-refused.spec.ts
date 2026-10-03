import { expect, test } from '@playwright/test';
import { fetchJson, getAccessToken } from '../helpers';
import type { UploadedTextFile } from './documents.helpers';
import { documentFixture, openLegacyComposer, uploadAsText } from './documents.helpers';

/**
 * A `.docx` is a zip container, so a decompression bomb reaches the parser as an
 * ordinary document. It is refused on the declared entry sizes, before any engine
 * inflates it, and nothing is stored.
 */
test('a decompression-bomb document is refused before it is parsed @scenario:archive-bomb-upload-refused', async ({
  page,
}) => {
  test.setTimeout(180000);
  await openLegacyComposer(page);

  const upload = documentFixture('bomb.docx');
  const response = await uploadAsText(page, upload);

  expect(response.status()).toBe(413);
  const body = (await response.json()) as { message?: string };
  expect(body.message).toMatch(/decompressed cap|decompressed size|decompressed limit/i);

  const token = await getAccessToken(page);
  const files = await fetchJson<UploadedTextFile[]>(page, '/api/files', token);
  expect(files.find((file) => file.filename === upload.name)).toBeUndefined();
});
