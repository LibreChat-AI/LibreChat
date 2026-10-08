import { expect, test } from '@playwright/test';
import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { Page } from '@playwright/test';

/**
 * The My Files table renders only the rows near its scroll position. With a list
 * far longer than the dialog, scrolling has to keep mounting rows down to the
 * last file, and each mounted row has to report its place in the whole list.
 * The account menu sits behind the mobile drawer on a phone-width viewport, so
 * this scenario uses a desktop viewport.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const FILE_COUNT = 200;

const files: TFile[] = Array.from({ length: FILE_COUNT }, (_, index) => ({
  file_id: `virtual-file-${index}`,
  filename: `Virtual fixture ${String(index).padStart(3, '0')}.txt`,
  filepath: `/files/virtual-file-${index}.txt`,
  user: 'virtual-files-user',
  bytes: 100,
  object: 'file',
  source: FileSources.local,
  type: 'text/plain',
  usage: 0,
  embedded: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}));

async function openMyFiles(page: Page) {
  await page.route('**/api/files', (route) => route.fulfill({ json: files }));
  await page.goto('/c/new', { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'My Files', exact: true });
  await expect(dialog).toBeVisible({ timeout: 15000 });
  const table = dialog.getByRole('table');
  await expect(table.locator('tbody tr[aria-rowindex="2"]')).toBeVisible();
  return { dialog, table };
}

/** Wheels over the table until the last row is mounted, as a user scrolling down would. */
async function scrollToLastRow(page: Page, table: ReturnType<Page['getByRole']>) {
  const lastRow = table.locator(`tbody tr[aria-rowindex="${FILE_COUNT + 1}"]`);
  await table.hover();
  for (let attempt = 0; attempt < 80 && (await lastRow.count()) === 0; attempt++) {
    await page.mouse.wheel(0, 1200);
  }
  return lastRow;
}

test.describe('my files virtual table', () => {
  test('scrolling the files table reaches the last file @scenario:my-files-scroll-reaches-last-file', async ({
    page,
  }) => {
    const { table } = await openMyFiles(page);
    const mounted = await table.locator('tbody tr[aria-rowindex]').count();
    expect(mounted).toBeLessThan(FILE_COUNT);

    const lastRow = await scrollToLastRow(page, table);
    await expect(lastRow).toBeInViewport();
    await expect(lastRow).toContainText('Virtual fixture');
  });

  test('a mounted file row reports its position in the whole list @scenario:my-files-rows-report-position', async ({
    page,
  }) => {
    const { table } = await openMyFiles(page);
    await expect(table).toHaveAttribute('aria-rowcount', String(FILE_COUNT + 1));
    await expect(table.locator('thead tr')).toHaveAttribute('aria-rowindex', '1');

    const lastRow = await scrollToLastRow(page, table);
    await expect(lastRow).toBeInViewport();
    /* The spacer rows that stand in for unmounted files stay out of the tree. */
    const spacers = table.locator('tbody tr:not([aria-rowindex])');
    for (const spacer of await spacers.all()) {
      await expect(spacer).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
