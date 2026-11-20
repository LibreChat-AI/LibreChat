import { expect, test } from '@playwright/test';
import path from 'node:path';
import { access, unlink } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  uniqueName,
  sendMessage,
  messagesView,
  selectMockEndpoint,
  uploadViaUnifiedButton,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * Storage retention (an S3 or Azure lifecycle rule) can delete an attachment's stored object
 * while its file record stays on the message. Mock Provider B routes markdown to the provider,
 * so every later turn re-reads the object from local storage, which is where the miss surfaces.
 */
const uploadsRoot = path.resolve(__dirname, '../../../../uploads');

async function deleteStoredObject(file: UploadedFile & { filepath?: string }) {
  const relative = file.filepath?.split('/uploads/')[1];
  expect(relative, 'upload response carries a local /uploads/ path').toBeTruthy();
  const fullPath = path.join(uploadsRoot, relative as string);
  await access(fullPath);
  await unlink(fullPath);
}

async function attachMarkdown(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
  const name = `${uniqueName('retained')}.md`;
  const response = await uploadViaUnifiedButton(page, {
    name,
    mimeType: 'text/markdown',
    content: '# Quarterly notes\n\nThis file is deleted by storage retention.\n',
  });
  expect(response.ok()).toBeTruthy();
  const file = (await response.json()) as UploadedFile & { filepath?: string };
  expect(file.llmDeliveryPath).toBe('provider');
  await expect(
    page.getByTestId('composer-tray').getByRole('button', { name, exact: true }),
  ).toBeVisible({ timeout: 15000 });
  return { name, file };
}

async function startWithDeletedAttachment(page: Page) {
  const { name, file } = await attachMarkdown(page);
  await sendMessageAndWaitForCompletion(page, 'Read the attached notes.');
  await deleteStoredObject(file);
  return name;
}

test.describe('attachments deleted from storage', () => {
  test('a follow-up answers after an earlier attachment is deleted from storage @scenario:deleted-history-attachment-follow-up-answers', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await startWithDeletedAttachment(page);

    await sendMessageAndWaitForCompletion(page, 'Thanks, one more question.');
    await sendMessageAndWaitForCompletion(page, 'And a third turn in the same chat.');
    await expect(messagesView(page).getByText('no longer available')).toHaveCount(0);
  });

  test('the model is told which earlier attachment storage deleted @scenario:deleted-history-attachment-named-to-model', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = await startWithDeletedAttachment(page);

    await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${name}`);
    await expect(
      messagesView(page).getByText(`E2E history assertion present: ${name}`),
    ).toBeVisible({ timeout: 30000 });

    await sendMessageAndWaitForCompletion(page, 'E2E_ASSERT_HISTORY:storage');
    await expect(
      messagesView(page).getByText('E2E history assertion present: storage'),
    ).toBeVisible({ timeout: 30000 });
  });

  test('a file attached this turn that storage lost still fails with the attachment error @scenario:deleted-current-attachment-still-errors', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const { file } = await attachMarkdown(page);
    await deleteStoredObject(file);

    const response = await sendMessage(page, 'Read the attached notes.');
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(/attached file is no longer available/)).toBeVisible({
      timeout: 30000,
    });
  });
});
