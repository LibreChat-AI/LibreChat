import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint, uniqueName } from '../helpers';

/**
 * A refused attachment explains why in an error toast, and the reason only helps if it can be
 * read. The toast stays open until it is dismissed, and a later notice, such as the delayed
 * "still uploading" one, does not replace it.
 */
const EMPTY_FILE_REASON = 'Empty files are not allowed.';
const UPLOAD_DELAY_NOTICE = 'is taking more time than anticipated';

async function openComposer(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
  /** Time keeps flowing; the scenarios jump it past the toast and upload timers instead of sleeping. */
  await page.clock.install();
}

async function attachFile(page: Page, file: { name: string; mimeType: string; content: string }) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools' });
  const localUpload = palette.getByRole('button', {
    name: /^(From Local Computer|Upload to Provider)$/,
  });
  await expect(localUpload).toBeVisible();

  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), localUpload.click()]);
  await fileChooser.setFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.content, 'utf8'),
  });
}

const emptyFile = { name: 'empty.md', mimeType: 'text/markdown', content: '' };

test('an upload error toast stays open past five seconds until it is dismissed @scenario:an-upload-error-toast-stays-open-until-it-is-dismissed', async ({
  page,
}) => {
  test.setTimeout(90000);
  await openComposer(page);
  const toast = page.locator('.toast-root[data-state="open"]');

  await attachFile(page, emptyFile);
  await expect(toast).toContainText(EMPTY_FILE_REASON);

  /** Well past the five seconds the toast used to allow. */
  await page.clock.runFor(10_000);
  await page.waitForTimeout(500);
  await expect(toast).toContainText(EMPTY_FILE_REASON);

  await toast.getByRole('button', { name: 'Close' }).click();
  await expect(toast).toBeHidden();

  /** A refusal that stays up must also be dismissible without a pointer. */
  await attachFile(page, emptyFile);
  await expect(toast).toContainText(EMPTY_FILE_REASON);
  await page.keyboard.press('Escape');
  await expect(toast).toBeHidden();
});

test('a delayed upload notice does not replace an open upload error toast @scenario:a-delayed-upload-notice-does-not-replace-an-open-upload-error-toast', async ({
  page,
}) => {
  test.setTimeout(90000);
  let releaseUpload = () => {};
  const uploadHeld = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  await page.route(/\/api\/files$/, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await uploadHeld;
    await route.continue();
  });

  try {
    await openComposer(page);
    const toast = page.locator('.toast-root[data-state="open"]');

    /** A file that is still uploading arms the "taking more time than anticipated" notice. */
    const uploadStarted = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/api/files' && request.method() === 'POST',
    );
    await attachFile(page, {
      name: `${uniqueName('slow')}.md`,
      mimeType: 'text/markdown',
      content: '# still uploading\n',
    });
    await uploadStarted;

    await attachFile(page, emptyFile);
    await expect(toast).toContainText(EMPTY_FILE_REASON);

    /** Past the notice's delay, which fires while the error toast is open. */
    await page.clock.runFor(6_000);
    await page.waitForTimeout(500);
    await expect(toast).toContainText(EMPTY_FILE_REASON);
    await expect(page.getByText(UPLOAD_DELAY_NOTICE)).toHaveCount(0);
  } finally {
    releaseUpload();
  }
});
