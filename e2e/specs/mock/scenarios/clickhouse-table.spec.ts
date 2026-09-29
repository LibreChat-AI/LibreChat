import { expect, test } from '@playwright/test';
import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';

/**
 * The shared table reads its header text, its row rule and its cell density from theme roles.
 * Click UI rules its rows with a 1px `stroke.default` and names columns in `text.default`;
 * LibreChat's own table has no rules and secondary column names, and keeps them without a theme.
 * The My Files table is a real consumer of the primitive, with a routed file list.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';
type ThemeChoice = 'clickhouse' | 'default';

const files: TFile[] = Array.from({ length: 3 }, (_, index) => ({
  file_id: `table-theme-file-${index}`,
  filename: `Table theme fixture ${index}.txt`,
  filepath: `/files/table-theme-file-${index}.txt`,
  user: 'table-theme-user',
  bytes: 100,
  object: 'file',
  source: FileSources.local,
  type: 'text/plain',
  usage: 0,
  embedded: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}));

/** One init script per page; the theme and mode each navigation wants ride in its URL. */
async function installThemeBridge(page: Page) {
  await page.addInitScript((definition) => {
    const params = new URL(location.href).searchParams;
    const theme = params.get('e2eTheme');
    const mode = params.get('e2eThemeMode');
    if (theme === null || mode === null) {
      return;
    }
    localStorage.setItem('color-theme', mode);
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (theme === 'clickhouse') {
      localStorage.setItem('theme-definition', JSON.stringify(definition));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, clickHouseTheme);
}

async function measureFilesTable(page: Page, theme: ThemeChoice, mode: Mode) {
  await page.goto(`/c/new?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'My Files' });
  const header = dialog.locator('thead');
  await expect(header).toBeVisible();
  await expect(dialog.getByText(files[0].filename)).toBeVisible();
  const readings = await header.evaluate((thead) => {
    const cell = thead.querySelector('th') as HTMLElement;
    const firstBodyCell = thead.parentElement?.querySelector('tbody td') as HTMLElement;
    /** Read off cells: under separated borders a row's own border is never drawn. */
    return {
      headerFill: getComputedStyle(thead).backgroundColor,
      headerText: getComputedStyle(cell).color,
      headerRule: getComputedStyle(cell).borderBottomWidth,
      rowRule: getComputedStyle(firstBodyCell).borderBottomWidth,
      ruleColor: getComputedStyle(firstBodyCell).borderBottomColor,
    };
  });
  await page.keyboard.press('Escape');
  return readings;
}

const rgb = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

test.describe('theme table', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/files', (route) => route.fulfill({ json: files }));
    await installThemeBridge(page);
  });

  test('the files table takes Click UI header text, fill and row rules under the ClickHouse theme @scenario:clickhouse-table-follows-click-ui', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as Mode[]) {
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};
      const readings = await measureFilesTable(page, 'clickhouse', mode);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');

      expect(readings).toEqual({
        headerFill: rgb(colors['rgb-surface-secondary']),
        headerText: rgb(colors['rgb-table-header-text']),
        headerRule: '1px',
        rowRule: '1px',
        ruleColor: rgb(colors['rgb-border-light']),
      });
    }
  });

  test('the default theme keeps an unruled table with secondary column names @scenario:default-theme-table-unchanged', async ({
    page,
  }) => {
    for (const mode of ['light', 'dark'] as Mode[]) {
      const readings = await measureFilesTable(page, 'default', mode);
      const expected = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const color = (name: string) =>
          `rgb(${root.getPropertyValue(name).trim().split(' ').join(', ')})`;
        return { fill: color('--surface-secondary'), text: color('--text-secondary') };
      });

      expect(readings).toMatchObject({
        headerFill: expected.fill,
        headerText: expected.text,
        headerRule: '0px',
        rowRule: '0px',
      });
    }
  });
});
