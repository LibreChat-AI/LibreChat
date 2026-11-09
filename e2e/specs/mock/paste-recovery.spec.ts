import { test, expect } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint } from './helpers';
for (const { failCorrection, failBeforeSave } of [
  { failCorrection: false, failBeforeSave: false },
  { failCorrection: true, failBeforeSave: false },
  { failCorrection: false, failBeforeSave: true },
]) {
  test(`original upload failure cannot revive superseded text (correction fails: ${failCorrection}, before save: ${failBeforeSave})`, async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
    let failOriginal = () => {};
    let releaseCorrection = () => {};
    const originalGate = new Promise<void>((resolve) => {
      failOriginal = resolve;
    });
    const correctionGate = new Promise<void>((resolve) => {
      releaseCorrection = resolve;
    });
    let requests = 0;
    await page.route('**/api/files', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const request = ++requests;
      await (request === 1 ? originalGate : correctionGate);
      return route.fulfill({ status: 500, json: { message: 'com_error_files_upload' } });
    });
    try {
      const input = page.getByTestId('text-input');
      const original = 'Original clipboard text.\n'.repeat(120);
      const correction = 'Only the latest correction belongs in this message.\n'.repeat(80);
      await input.fill('Review this');
      await input.evaluate((element, text) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
        );
      }, original);
      await expect.poll(() => requests).toBe(1);
      await page.getByRole('button', { name: 'Edit pasted text, pasted-text.txt' }).click();
      const failSource = async () => {
        const response = page.waitForResponse(
          (response) => response.url().endsWith('/api/files') && response.status() === 500,
        );
        failOriginal();
        await response;
        await expect(input).toHaveValue('Review this');
      };
      if (failBeforeSave) await failSource();
      await page.getByRole('textbox', { name: 'Edit pasted text' }).fill(correction);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => requests).toBe(2);
      if (!failBeforeSave) await failSource();
      await expect(
        page.getByRole('button', { name: 'Edit pasted text, pasted-text-2.txt' }),
      ).toBeVisible();
      if (failCorrection) {
        releaseCorrection();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Edit pasted text' })).toHaveValue(
          correction,
        );
        await expect(input).toHaveValue('Review this');
      } else {
        const sent = page.waitForRequest(
          (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
        );
        await input.press('Enter');
        const payload = (await sent).postDataJSON();
        expect(payload.files ?? []).toHaveLength(0);
        expect(payload.text).toBe(`Review this\n\n\`\`\`text\n${correction}\n\`\`\``);
        await expect(page.getByTestId('composer-tray')).toHaveCount(0);
      }
    } finally {
      failOriginal();
      releaseCorrection();
    }
  });
}
