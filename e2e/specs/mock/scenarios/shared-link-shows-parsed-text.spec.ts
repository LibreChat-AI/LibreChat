import { expect, test } from '@playwright/test';
import { getAccessToken, mockReply, requestJson, sendMessage } from '../helpers';
import type { UploadedTextFile } from './documents.helpers';
import { documentFixture, openUnifiedComposer, uploadViaUnifiedButton } from './documents.helpers';

/**
 * A parsed document has no downloadable preview of its own: its content is the text the
 * server extracted. A viewer of a shared conversation must therefore be able to read
 * that text, or the attachment is a dead chip on the public page.
 *
 * The link is published through the share endpoint rather than the header menu, whose
 * placement differs per viewport: what this scenario is about is what the viewer gets,
 * and the owner's publishing UI is covered by shared-links.spec.ts.
 */
test('a viewer of a shared conversation can read the parsed document text @scenario:shared-link-shows-parsed-text', async ({
  page,
}) => {
  test.setTimeout(240000);

  await openUnifiedComposer(page);
  const upload = documentFixture('structured.docx');
  const uploadResponse = await uploadViaUnifiedButton(page, upload);
  expect(uploadResponse.status(), await uploadResponse.text()).toBe(200);
  expect(((await uploadResponse.json()) as UploadedTextFile).llmDeliveryPath).toBe('text');

  const prompt = `Shared parsed document ${Date.now()}`;
  const sent = await sendMessage(page, prompt);
  expect(sent.ok()).toBeTruthy();
  await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
  const conversationId = new URL(page.url()).pathname.split('/').pop();

  const token = await getAccessToken(page);
  const share = await requestJson<{ shareId?: string }>(page, {
    path: `/api/share/${conversationId}`,
    token,
    method: 'POST',
    body: { snapshotFiles: true },
  });
  expect(share.shareId, 'publishing the conversation should return a shareId').toBeTruthy();

  await page.goto(`/share/${share.shareId}`, { timeout: 15000 });
  await expect(page.getByTestId('messages-view').getByText(prompt, { exact: true })).toBeVisible({
    timeout: 30000,
  });

  await page
    .getByTestId('messages-view')
    .getByRole('button', { name: upload.name, exact: true })
    .click();

  /* The shared message view opens the file preview dialog, which reads the text through
   * the share-scoped preview route because the snapshot carries llmDeliveryPath=text. */
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect(dialog).toContainText('Quarterly Report', { timeout: 30000 });
});
