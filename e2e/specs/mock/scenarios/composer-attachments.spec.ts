import { expect, test } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint } from '../helpers';

/** Past the composer's paste-as-file threshold, so the paste lands as a chip. */
const LONG_PASTE = Array.from(
  { length: 60 },
  (_, index) => `pasted line ${index + 1}: enough prose to cross the attach-as-file threshold`,
).join('\n');

test.describe('composer attachments', () => {
  test('a long paste becomes a chip whose editor saves the corrected text @scenario:a-long-paste-becomes-an-editable-chip-whose-edit-is-saved', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const textarea = page.getByTestId('text-input');
    await textarea.click();
    const firstUpload = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/files' && response.request().method() === 'POST',
      { timeout: 30000 },
    );
    await textarea.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, LONG_PASTE);
    expect((await firstUpload).ok()).toBe(true);

    await expect(textarea).toHaveValue('');
    const chip = page.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' });
    await expect(chip).toBeVisible();

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Edit pasted text' });
    const editor = dialog.getByRole('textbox', { name: 'Edit pasted text' });
    await expect(editor).toHaveValue(LONG_PASTE);

    const corrected = `${LONG_PASTE}\ncorrected closing line`;
    await editor.fill(corrected);
    const savedUpload = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/files' && response.request().method() === 'POST',
      { timeout: 30000 },
    );
    await dialog.getByRole('button', { name: 'Save' }).click();
    expect((await savedUpload).ok()).toBe(true);
    await expect(dialog).toBeHidden();

    /** The correction uploads under a free name, so the edited text lives on its own chip. */
    const replacement = page.getByRole('button', {
      name: 'Edit pasted text, pasted-text-2.txt',
    });
    await expect(replacement).toBeVisible({ timeout: 15000 });
    await replacement.click();
    const reopened = page.getByRole('dialog', { name: 'Edit pasted text' });
    await expect(reopened.getByRole('textbox')).toHaveValue(corrected);
    await page.keyboard.press('Escape');
    await expect(reopened).toBeHidden();
  });
});
