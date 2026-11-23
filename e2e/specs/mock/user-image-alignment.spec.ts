import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

const imageFixture = {
  name: 'upload.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNwaDjwnxLMMGrA/9EwODAaBg3DIgwACY9/HwbtciYAAAAASUVORK5CYII=',
    'base64',
  ),
};

const prompt =
  'This image shows a background task in the conversation. Please describe the image layout and explain what the task is doing.';

test.use({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });

test('keeps uploaded user images on the right side of a wider message bubble', async ({ page }) => {
  test.setTimeout(75_000);
  await page.addInitScript(() => localStorage.setItem('color-theme', 'dark'));
  await page.goto(NEW_CHAT_PATH);
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools' });
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    palette.getByRole('button', { name: 'Upload to Provider', exact: true }).click(),
  ]);
  const upload = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/files/images' &&
      response.request().method() === 'POST' &&
      response.status() === 200,
  );
  await fileChooser.setFiles(imageFixture);
  expect((await upload).ok()).toBeTruthy();

  const response = await sendMessageAndWaitForCompletion(page, prompt);
  expect(response.ok()).toBeTruthy();

  const userTurn = messagesView(page).locator('.message-render').filter({ hasText: prompt }).last();
  await expect(userTurn.locator('.user-turn')).toBeVisible();
  const image = userTurn.getByRole('img', { name: imageFixture.name });
  await expect(image).toBeVisible();
  await image.evaluate(async (element) => (element as HTMLImageElement).decode());

  const captureDir = process.env.E2E_CAPTURE_DIR;
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    await userTurn.screenshot({
      path: path.join(captureDir, 'user-image.png'),
      animations: 'disabled',
    });
  }

  const imageBox = await image.locator('xpath=../..').boundingBox();
  const bubbleBox = await userTurn.getByTestId('message-body').boundingBox();
  if (imageBox == null || bubbleBox == null) {
    throw new Error('The user image and message bubble must have measurable bounds.');
  }
  const leftInset = imageBox.x - bubbleBox.x;
  const rightInset = bubbleBox.x + bubbleBox.width - (imageBox.x + imageBox.width);
  expect(leftInset - rightInset).toBeGreaterThan(40);
});
