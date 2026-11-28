import { expect, test } from '@playwright/test';
import { FileContext, FileSources } from 'librechat-data-provider';
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
  filepath:
    index === 2
      ? '/api/files/code/download/session-2/file-2?execution_profile=stateful'
      : `/files/virtual-file-${index}.txt`,
  user: 'virtual-files-user',
  bytes: 100,
  object: 'file',
  source:
    [FileSources.azure, FileSources.local, FileSources.execute_code][index] ?? FileSources.local,
  context: FileContext.message_attachment,
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

/** Wheels over the table until the last row enters the viewport, as a user scrolling down would. */
async function scrollToLastRow(page: Page, table: ReturnType<Page['getByRole']>) {
  const lastRow = table.locator(`tbody tr[aria-rowindex="${FILE_COUNT + 1}"]`);
  await table.hover();
  // Overscan mounts rows before they enter the visible scroll region.
  await expect(async () => {
    await page.mouse.wheel(0, 1200);
    await expect(lastRow).toBeInViewport({ timeout: 200 });
  }).toPass({ intervals: [50], timeout: 15_000 });
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

test('confirming deletes only the selected file after cancel @scenario:my-files-delete-confirm', async ({
  page,
}) => {
  const { dialog, table } = await openMyFiles(page);
  const requests: string[][] = [];
  await page.route('**/api/files', async (route) => {
    if (route.request().method() !== 'DELETE') {
      return route.fallback();
    }
    const ids = route
      .request()
      .postDataJSON()
      .files.map((file: TFile) => file.file_id);
    requests.push(ids);
    await route.fulfill({ json: { message: 'Deleted', deletedFileIds: ids, failedFileIds: [] } });
  });
  const row = table.getByRole('row').filter({ hasText: files[1].filename });
  await row.getByRole('checkbox').click();
  const trigger = dialog.getByRole('button', { name: 'Delete', exact: true });
  await trigger.click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText(files[1].filename);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  expect(requests).toEqual([]);
  await trigger.click();
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(requests).toEqual([[files[1].file_id]]);
});

test('filters and sorts files without scrolling the surrounding dialog @scenario:my-files-layout', async ({
  page,
}) => {
  const { dialog, table } = await openMyFiles(page);
  const search = dialog.locator('#files-filter');
  await expect(search).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Storage', exact: true })).toBeVisible();
  await page.getByRole('menuitemcheckbox', { name: 'Azure', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').last()).toContainText(files[0].filename);
  await dialog.getByRole('button', { name: 'Filters active: 1' }).click();
  await page.getByRole('menuitem', { name: 'Clear filters' }).click();
  await dialog.getByRole('button', { name: 'Sort', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Z to A' }).click();
  await expect(table.locator('tbody tr[aria-rowindex="2"]')).toContainText(
    files[FILE_COUNT - 1].filename,
  );
  await search.fill('missing-name');
  await expect(table).toContainText('No results.');
  await table.getByRole('button', { name: 'Clear filters' }).click();
  const desktop = await dialog.boundingBox();
  expect(desktop!.width).toBeLessThanOrEqual(896);
  expect(desktop!.height).toBeLessThanOrEqual(673);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(table.getByRole('columnheader', { name: 'Size' })).toHaveCount(0);
  await expect(table.locator('tbody tr[aria-rowindex="2"]')).toContainText('100 B');
  const scrollers = await dialog.evaluate(
    (node) =>
      [node, ...node.querySelectorAll('*')].filter(
        (el) =>
          el.scrollHeight > el.clientHeight &&
          /^(auto|scroll)$/.test(getComputedStyle(el).overflowY),
      ).length,
  );
  expect(scrollers).toBe(1);
});

test('row actions use the selected file for details, preview, download and confirmation @scenario:my-files-row-actions', async ({
  page,
}) => {
  const file = files[1];
  const { dialog } = await openMyFiles(page);
  await page.route('**/api/files/download/*/' + file.file_id, (route) =>
    route.fulfill({ contentType: 'text/plain', body: 'Preview fixture content' }),
  );
  const trigger = dialog.getByRole('button', { name: 'Actions for ' + file.filename });
  const menu = page.getByRole('menu').last();
  await trigger.click();
  await menu.getByRole('menuitem', { name: 'Details' }).click();
  const details = page.getByRole('dialog', { name: 'Details' });
  await expect(details).toContainText(file.filename);
  await expect(details).toContainText('local');
  await expect(details).toContainText('Attachment (message_attachment)');
  await details.press('Escape');
  await menu.getByRole('menuitem', { name: 'Preview' }).click();
  const preview = page.getByRole('dialog').last();
  await expect(preview).toContainText('Preview fixture content');
  await preview.press('Escape');
  const download = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: 'Download' }).click();
  expect((await download).suggestedFilename()).toBe(file.filename);
  await trigger.click();
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toContainText(file.filename);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  const unavailable = dialog.getByRole('button', { name: 'Actions for ' + files[0].filename });
  await unavailable.click();
  await expect(menu.getByRole('menuitem', { name: 'Details' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Download' })).toHaveCount(0);
  await unavailable.click();
  await expect(unavailable).toHaveAttribute('aria-expanded', 'false');
  const output = files[2];
  await page.route('**' + output.filepath, (route) => route.fulfill({ body: 'code output' }));
  await dialog.getByRole('button', { name: 'Actions for ' + output.filename }).click();
  await expect(menu.getByRole('menuitem', { name: 'Preview' })).toHaveCount(0);
  const outputDownload = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: 'Download' }).click();
  expect((await outputDownload).suggestedFilename()).toBe(output.filename);
});

test('selection crossfades without moving the file list or retaining hidden controls @scenario:my-files-motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { dialog, table } = await openMyFiles(page);
  const list = dialog.getByRole('region', { name: 'My Files' });
  await list.evaluate((node) => {
    node.scrollTop = 1800;
  });
  const target = table.getByRole('row').filter({ hasText: files[36].filename });
  const checkbox = target.getByRole('checkbox');
  await checkbox.scrollIntoViewIfNeeded();
  await checkbox.focus();
  const before = await list.evaluate((node) => ({
    top: node.getBoundingClientRect().top,
    scroll: node.scrollTop,
  }));
  await checkbox.press('Space');
  await expect(checkbox).toBeChecked();
  const clear = dialog.getByRole('button', { name: 'Clear', exact: true });
  await expect(clear).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sort', exact: true })).toHaveCount(0);
  expect(await list.evaluate((node) => node.getBoundingClientRect().top)).toBe(before.top);
  expect(
    await clear.evaluate((node) => getComputedStyle(node.parentElement!).transitionDuration),
  ).toBe('0.15s');
  await checkbox.press('Space');
  await checkbox.press('Space');
  await expect(checkbox).toBeChecked();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await clear.evaluate((node) => getComputedStyle(node.parentElement!).transitionProperty),
  ).toBe('none');
  expect(await target.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe('none');
  await page.route('**/api/files', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          json: { message: 'Deleted', deletedFileIds: [files[36].file_id], failedFileIds: [] },
        })
      : route.fallback(),
  );
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(target).toHaveCount(0);
  await expect(list).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Sort', exact: true })).toBeVisible();
  expect(Math.abs((await list.evaluate((node) => node.scrollTop)) - before.scroll)).toBeLessThan(
    65,
  );
});
