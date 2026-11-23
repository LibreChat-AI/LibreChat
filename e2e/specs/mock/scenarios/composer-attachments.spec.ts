import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint } from '../helpers';

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
});
