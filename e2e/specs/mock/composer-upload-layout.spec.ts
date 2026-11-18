import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
  uploadViaUnifiedButton,
  uniqueName,
} from './helpers';

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test.describe(`composer uploads at ${viewport.width}px`, () => {
    test.use({ viewport });

    test('sends a pending long paste inline without waiting for its upload', async ({ page }) => {
      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
      const input = page.getByRole('textbox', { name: 'Message input' });
      const paste = 'Preview the exact pasted content.\n'.repeat(100);
      let releaseUpload = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      await page.route('**/api/files', async (route) => {
        if (route.request().method() === 'POST') {
          await gate;
          await route.abort();
          return;
        }
        await route.continue();
      });
      try {
        await input.fill('Use this text');
        await input.evaluate((element, text) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', text);
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
          );
        }, paste);
        const tray = page.getByTestId('composer-tray');
        await expect(tray).toContainText('Preview the exact pasted content.');
        await expect(page.getByTestId('send-button')).toBeEnabled();
        const sent = page.waitForRequest(
          (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
        );
        await input.press('Enter');
        const payload = (await sent).postDataJSON();
        expect(payload.text).toContain(`\`\`\`text\n${paste}\n\`\`\``);
        expect(payload.files ?? []).toHaveLength(0);
        await expect(tray).toHaveCount(0);
        releaseUpload();
        await expect(input).toHaveValue('');
      } finally {
        releaseUpload();
      }
    });

    test('keeps the textarea in place when uploading starts and finishes', async ({
      page,
    }, testInfo) => {
      await page.goto(NEW_CHAT_PATH);
      await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
      await sendMessageAndWaitForCompletion(page, 'E2E_REPLY:upload layout');

      const input = page.getByRole('textbox', { name: 'Message input' });
      await expect(page.getByTestId('composer-hints')).toHaveCount(0);
      await input.fill('Keep this draft');
      const before = await input.boundingBox();
      expect(before).not.toBeNull();

      let releaseUpload = () => {};
      const uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      await page.route('**/api/files', async (route) => {
        if (route.request().method() === 'POST') {
          await uploadGate;
        }
        await route.continue();
      });

      try {
        const upload = uploadViaUnifiedButton(page, {
          name: `${uniqueName('layout')}.md`,
          mimeType: 'text/markdown',
          content: '# Upload layout regression\n',
        });
        await expect(input).toHaveAccessibleDescription(/Uploading 1 file/);
        await expect(page.getByTestId('composer-tray')).toBeVisible();
        await expect(page.getByTestId('send-button')).toBeDisabled();
        const uploading = await input.boundingBox();

        releaseUpload();
        expect((await upload).ok()).toBeTruthy();
        await expect(input).not.toHaveAccessibleDescription(/Uploading/);
        await expect(page.getByTestId('send-button')).toBeEnabled();
        const complete = await input.boundingBox();

        await testInfo.attach('textarea-bounds', {
          body: JSON.stringify({ before, uploading, complete }),
          contentType: 'application/json',
        });
        expect(uploading).not.toBeNull();
        expect(complete).not.toBeNull();
        expect(Math.abs(uploading!.y - before!.y)).toBeLessThan(1);
        expect(Math.abs(complete!.y - uploading!.y)).toBeLessThan(1);
        expect(complete!.height).toBe(before!.height);
        await expect(input).toHaveValue('Keep this draft');
        await expect(page.getByTestId('composer-hints')).toHaveCount(0);
      } finally {
        releaseUpload();
      }
    });
  });
}
