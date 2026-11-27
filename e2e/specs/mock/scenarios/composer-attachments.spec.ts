import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  replyText,
  uniqueName,
  requestJson,
  replyPrompt,
  sendMessage,
  messagesView,
  getAccessToken,
  isAgentsStream,
  selectMockEndpoint,
  uploadViaUnifiedButton,
} from '../helpers';
import { deleteProjects } from '../db';

/** Past the composer's paste-as-file threshold, so the paste lands as a chip. */
const LONG_PASTE = Array.from(
  { length: 60 },
  (_, index) => `pasted line ${index + 1}: enough prose to cross the attach-as-file threshold`,
).join('\n');

const isFileRequest =
  (method: string) =>
  (response: Response): boolean =>
    new URL(response.url()).pathname === '/api/files' && response.request().method() === method;

/** Pastes past the threshold into the composer and waits for the chip's upload to be stored. */
async function pasteLongText(page: Page): Promise<void> {
  const textarea = page.getByTestId('text-input');
  await textarea.click();
  const upload = page.waitForResponse(isFileRequest('POST'), { timeout: 30000 });
  await textarea.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, LONG_PASTE);
  expect((await upload).ok()).toBe(true);
  await expect(textarea).toHaveValue('');
}

/** Holds every upload request until the returned release runs, so an attachment is still
 * uploading through whatever the test does next. */
async function holdUploads(page: Page): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/files', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    return route.continue();
  });
  return release;
}

/** Attaches a file through the palette and returns its chip once the held upload is requested. */
async function attachHeldFile(page: Page, prefix: string) {
  const fileName = `${uniqueName(prefix)}.md`;
  const requested = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/files',
    { timeout: 30000 },
  );
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
  const source = palette.getByRole('button', {
    name: /^(From Local Computer|Upload to Provider)$/,
  });
  await expect(source).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), source.click()]);
  await chooser.setFiles({
    name: fileName,
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# ${prefix}\n`, 'utf8'),
  });
  const chip = page
    .getByTestId('composer-tray')
    .getByRole('button', { name: fileName, exact: true });
  await expect(chip).toBeVisible({ timeout: 15000 });
  return { chip, request: await requested };
}

/** Lets the app apply what the last navigation or response changed before the next check. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

/** Sends the next turn and returns the ids of the files its request carried. */
async function sendFileIds(page: Page, label: string): Promise<Array<string | undefined>> {
  await page.getByRole('textbox', { name: 'Message input' }).fill(replyPrompt(label));
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
  );
  const [stream] = await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30000 }),
    page.getByTestId('send-button').click(),
  ]);
  expect(stream.ok()).toBe(true);
  const payload = (await sent).postDataJSON() as { files?: Array<{ file_id?: string }> };
  return (payload.files ?? []).map((file) => file.file_id);
}

test.describe('composer attachments', () => {
  test('a long paste becomes a chip whose editor saves the corrected text @scenario:a-long-paste-becomes-an-editable-chip-whose-edit-is-saved', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await pasteLongText(page);
    const chip = page.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' });
    await expect(chip).toBeVisible();

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Edit pasted text' });
    const editor = dialog.getByRole('textbox', { name: 'Edit pasted text' });
    await expect(editor).toHaveValue(LONG_PASTE);

    const corrected = `${LONG_PASTE}\ncorrected closing line`;
    await editor.fill(corrected);
    const savedUpload = page.waitForResponse(isFileRequest('POST'), { timeout: 30000 });
    await dialog.getByRole('button', { name: 'Save' }).click();
    expect((await savedUpload).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    /** The correction uploads under a free name, so the edited text lives on its own chip. */
    const replacement = page.getByRole('button', {
      name: 'Edit pasted text, pasted-text-2.txt',
    });
    await expect(replacement).toBeVisible({ timeout: 15000 });
    /** The original detaches once the replacement is stored, so only one copy rides the message. */
    await expect(chip).toHaveCount(0, { timeout: 15000 });
    await replacement.click();
    const reopened = page.getByRole('dialog', { name: 'Edit pasted text' });
    await expect(reopened.getByRole('textbox')).toHaveValue(corrected);
    await page.keyboard.press('Escape');
    await expect(reopened).toBeHidden();
  });

  test('a paste chip restored after a reload is replaced by its saved edit @scenario:a-restored-paste-chip-is-replaced-by-its-saved-edit', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await pasteLongText(page);
    const chip = page.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' });
    await expect(chip).toBeVisible();

    /** The reload rebuilds the chip from the persisted composer draft, which holds no local copy
     * of the text: the editor has to read it back from the stored upload. */
    await page.reload();
    await expect(chip).toBeVisible({ timeout: 20000 });
    await expect(chip).toHaveAccessibleDescription(/pasted line 1: enough prose/);
    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Edit pasted text' });
    const editor = dialog.getByRole('textbox', { name: 'Edit pasted text' });
    await expect(editor).toHaveValue(LONG_PASTE);

    const corrected = `${LONG_PASTE}\ncorrected closing line`;
    await editor.fill(corrected);
    const savedUpload = page.waitForResponse(isFileRequest('POST'), { timeout: 30000 });
    const originalDeleted = page.waitForResponse(isFileRequest('DELETE'), { timeout: 30000 });
    await dialog.getByRole('button', { name: 'Save' }).click();
    expect((await savedUpload).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    const replacement = page.getByRole('button', {
      name: 'Edit pasted text, pasted-text-2.txt',
    });
    await expect(replacement).toBeVisible({ timeout: 15000 });
    await expect(chip).toHaveCount(0, { timeout: 15000 });

    /** The stored original is deleted, and the file-cache refresh that follows must not bring
     * its chip back. Two frames let the app apply that response before the check. */
    expect((await originalDeleted).ok()).toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(chip).toHaveCount(0);
    await expect(replacement).toBeVisible();
  });

  test('an unsent chat keeps its attachment through a model switch and sends it @scenario:an-unsent-chat-keeps-its-attachment-through-a-model-switch', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);

    const fileName = `${uniqueName('switch')}.md`;
    const upload = await uploadViaUnifiedButton(page, {
      name: fileName,
      mimeType: 'text/markdown',
      content: '# Attached before the model switch\n',
    });
    expect(upload.ok()).toBe(true);
    const { file_id: fileId } = (await upload.json()) as UploadedFile;
    expect(fileId).toBeTruthy();
    const chip = page
      .getByTestId('composer-tray')
      .getByRole('button', { name: fileName, exact: true });
    await expect(chip).toBeVisible({ timeout: 15000 });

    /** Picking another model changes what the unsent chat is sent to, not which chat it is, so
     * the chip stays and nothing asks the server to delete the upload. */
    const deletions: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/files') {
        deletions.push(request.url());
      }
    });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await expect(chip).toBeVisible();

    await page.getByRole('textbox', { name: 'Message input' }).fill(replyPrompt('kept-attachment'));
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
    );
    const [stream] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      page.getByTestId('send-button').click(),
    ]);
    expect(stream.ok()).toBe(true);
    const payload = (await sent).postDataJSON() as { files?: Array<{ file_id?: string }> };
    expect((payload.files ?? []).map((file) => file.file_id)).toEqual([fileId]);
    await expect(messagesView(page).getByText(replyText('kept-attachment'))).toBeVisible({
      timeout: 20000,
    });
    expect(deletions).toEqual([]);
  });

  test('an upload still running through a model switch stays with the unsent chat @scenario:an-upload-still-running-through-a-model-switch-stays-with-the-unsent-chat', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    const release = await holdUploads(page);
    try {
      const { chip, request } = await attachHeldFile(page, 'switch-uploading');
      /** The new selection is written into the address while the upload is still running. */
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await settle(page);
      await expect(chip).toBeVisible();

      release();
      const stored = await request.response();
      if (stored == null) throw new Error('The held upload was never answered');
      expect(stored.ok()).toBe(true);
      const { file_id: fileId } = (await stored.json()) as UploadedFile;
      expect(fileId).toBeTruthy();
      await expect(chip).toBeVisible();
      expect(await sendFileIds(page, 'switched-upload')).toEqual([fileId]);
    } finally {
      release();
    }
  });

  for (const { scope, scenario } of [
    {
      scope: 'chat',
      scenario: 'a-file-attached-during-a-new-chats-first-reply-stays-after-it-ends',
    },
    {
      scope: 'project chat',
      scenario: 'a-file-attached-during-a-new-project-chats-first-reply-stays-after-it-ends',
    },
  ]) {
    test(`a file attached while a new ${scope} streams its first reply stays after the reply ends @scenario:${scenario}`, async ({
      page,
    }) => {
      test.setTimeout(90000);
      let projectId: string | undefined;
      if (scope === 'project chat') {
        await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
        const project = await requestJson<{ _id: string }>(page, {
          path: '/api/projects',
          token: await getAccessToken(page),
          method: 'POST',
          body: { name: uniqueName('first-reply project') },
        });
        projectId = project._id;
      }
      const release = await holdUploads(page);
      try {
        await page.goto(projectId ? `${NEW_CHAT_PATH}?projectId=${projectId}` : NEW_CHAT_PATH, {
          timeout: 10000,
        });
        await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
        const messages = messagesView(page);
        const run = await sendMessage(page, `E2E_SLOW_REPLY:${uniqueName('first-reply')}`);
        expect(run.ok()).toBe(true);
        await expect(messages.getByText('chunk-010')).toBeVisible({ timeout: 15000 });

        const { chip, request } = await attachHeldFile(page, 'first-reply');
        await expect(page.getByTestId('stop-generation-button')).toBeVisible();
        /** The reply ends while the upload is still held: the chat now has its id and address. */
        await expect(messages.getByText('chunk-159')).toBeVisible({ timeout: 30000 });
        await expect(page.getByTestId('stop-generation-button')).toBeHidden({ timeout: 30000 });
        await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
        await settle(page);
        await expect(chip).toBeVisible();

        release();
        const stored = await request.response();
        if (stored == null) throw new Error('The held upload was never answered');
        expect(stored.ok()).toBe(true);
        const { file_id: fileId } = (await stored.json()) as UploadedFile;
        expect(fileId).toBeTruthy();
        await expect(chip).toBeVisible();
        expect(await sendFileIds(page, 'after-first-reply')).toEqual([fileId]);
      } finally {
        release();
        if (projectId) await deleteProjects([projectId]);
      }
    });
  }
});
