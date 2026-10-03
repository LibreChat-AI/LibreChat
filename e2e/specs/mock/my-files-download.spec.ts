import fs from 'fs';
import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../setup/user';
import { NEW_CHAT_PATH } from './helpers';
import { withMongo } from './db';

const content = 'My Files download regression fixture.\n';

for (const appearance of [
  { name: 'light desktop', theme: 'light', width: 1280, height: 900 },
  { name: 'dark desktop', theme: 'dark', width: 1280, height: 900 },
  { name: 'light mobile', theme: 'light', width: 390, height: 844 },
]) {
  test(`My Files downloads without changing selection (${appearance.name})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const fileId = randomUUID();
    const filename = `download-${fileId}.txt`;
    await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email: getE2EUser().email });
      if (!user) {
        throw new Error('My Files fixture requires the authenticated E2E user');
      }
      await db.collection('files').insertOne({
        user: user._id,
        file_id: fileId,
        filename,
        filepath: '',
        bytes: Buffer.byteLength(content),
        type: 'text/plain',
        source: 'text',
        context: 'message_attachment',
        object: 'file',
        text: content,
        textFormat: 'text',
        status: 'ready',
        usage: 0,
        ...(user.tenantId ? { tenantId: user.tenantId } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    try {
      await page.setViewportSize({ width: appearance.width, height: appearance.height });
      await page.addInitScript((theme) => {
        localStorage.setItem('theme', theme);
        localStorage.setItem('navVisible', 'true');
      }, appearance.theme);
      await page.goto(NEW_CHAT_PATH);
      await page.getByTestId('nav-user').click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Data & Privacy' }).click();
      await page.getByRole('button', { name: 'Manage Files', exact: true }).click();

      const dialog = page.getByRole('dialog', { name: 'My Files', exact: true });
      const row = dialog.getByRole('row').filter({ hasText: filename });
      const checkbox = row.getByRole('checkbox');
      const downloadButton = row.getByRole('button', { name: `Download ${filename}`, exact: true });
      await expect(downloadButton).toBeVisible();
      await expect(checkbox).not.toBeChecked();
      await page.screenshot({ path: testInfo.outputPath('my-files.png'), fullPage: true });

      const downloadPromise = page.waitForEvent('download');
      await downloadButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(filename);
      expect(await fs.promises.readFile(await download.path(), 'utf8')).toBe(content);
      await expect(checkbox).not.toBeChecked();

      await checkbox.check();
      await withMongo(async (db) => {
        await db.collection('files').updateOne({ file_id: fileId }, { $unset: { text: '' } });
      });
      await downloadButton.click();
      await expect(
        page.getByText('Error downloading file. The file may have been deleted.'),
      ).toBeVisible();
      await expect(checkbox).toBeChecked();
      await expect(downloadButton).toBeEnabled();
    } finally {
      await withMongo(async (db) => {
        await db.collection('files').deleteOne({ file_id: fileId });
      });
    }
  });
}
