import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { deleteConversations, withMongo } from '../db';
import { getE2EUser } from '../../../setup/user';

/**
 * The shared table reads its header text, its row rule and its cell density from theme roles.
 * Click UI rules its rows with a 1px `stroke.default` and names columns in `text.default`;
 * LibreChat's own table has no rules and secondary column names, and keeps them without a theme.
 * The My Files table is a real consumer of the primitive, with a routed file list.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';
type ThemeChoice = 'clickhouse' | 'default' | 'dense';

/** The ClickHouse theme with half the table cell space, to show the role reaching real tables. */
const denseTheme = {
  ...clickHouseTheme,
  name: 'clickhouse-dense',
  modes: Object.fromEntries(
    Object.entries(clickHouseTheme.modes).map(([mode, definition]) => [
      mode,
      { ...definition, appearance: { ...definition?.appearance, tableCellSpaceY: '0.5rem' } },
    ]),
  ),
};

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
  await page.addInitScript(
    (definitions) => {
      const params = new URL(location.href).searchParams;
      const theme = params.get('e2eTheme');
      const mode = params.get('e2eThemeMode');
      if (theme === null || mode === null) {
        return;
      }
      localStorage.setItem('color-theme', mode);
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      const definition = (definitions as Record<string, unknown>)[theme];
      if (definition) {
        localStorage.setItem('theme-definition', JSON.stringify(definition));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    { clickhouse: clickHouseTheme, dense: denseTheme },
  );
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

  test('the table cell space reaches the data tables that draw compact rows @scenario:table-density-role-reaches-data-tables', async ({
    page,
  }) => {
    const readings: Record<string, { cell: string; head: string }> = {};
    for (const theme of ['default', 'clickhouse', 'dense'] as ThemeChoice[]) {
      await page.goto(`/c/new?e2eTheme=${theme}&e2eThemeMode=light`, { timeout: 15000 });
      await page.getByTestId('nav-user').click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'My Files' });
      await expect(dialog.getByText(files[0].filename)).toBeVisible();
      readings[theme] = await dialog.locator('table').evaluate((table) => ({
        cell: getComputedStyle(table.querySelector('tbody td') as HTMLElement).paddingTop,
        head: getComputedStyle(table.querySelector('thead th') as HTMLElement).paddingTop,
      }));
      await page.keyboard.press('Escape');
    }

    /** Half the space from `sm` up: 8px at LibreChat's and Click UI's 1rem, 4px at 0.5rem. */
    expect(readings).toEqual({
      default: { cell: '8px', head: '8px' },
      clickhouse: { cell: '8px', head: '8px' },
      dense: { cell: '4px', head: '4px' },
    });
  });

  test('the archived chats header takes the table header fill @scenario:archived-chats-header-follows-table-header-fill', async ({
    page,
  }) => {
    const conversationId = randomUUID();
    const { email } = getE2EUser();
    await withMongo(async (db) => {
      const user = await db.collection('users').findOne({ email });
      await db.collection('conversations').insertOne({
        conversationId,
        title: 'Archived header fixture',
        user: String(user?._id),
        endpoint: 'openAI',
        isArchived: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
      });
    });

    /** The header height less its text line: the cell space a theme sets, apart from the line
     *  height its own type scale draws. */
    const spaces: Record<string, number> = {};
    try {
      for (const [theme, mode] of [
        ['default', 'light'],
        ['clickhouse', 'light'],
        ['clickhouse', 'dark'],
        ['dense', 'light'],
      ] as Array<[ThemeChoice, Mode]>) {
        await page.goto(`/c/new?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
        await page.getByTestId('nav-user').click();
        await page.getByRole('menuitem', { name: 'Archived chats' }).click();
        const dialog = page.getByRole('dialog', { name: 'Archived chats' });
        await expect(dialog.getByText('Archived header fixture')).toBeVisible({ timeout: 15000 });
        const header = dialog.locator('thead th').first();
        const reading = await header.evaluate((cell) => ({
          fill: getComputedStyle(cell).backgroundColor,
          space: (cell as HTMLElement).offsetHeight - parseFloat(getComputedStyle(cell).lineHeight),
          expected: (() => {
            const root = getComputedStyle(document.documentElement);
            return `rgb(${root.getPropertyValue('--surface-dialog').trim().split(' ').join(', ')})`;
          })(),
        }));

        spaces[`${theme}-${mode}`] = reading.space;
        if (theme === 'default') {
          /** The dialog surface it always had. */
          expect(reading.fill).toBe(reading.expected);
        } else {
          const colors = clickHouseTheme.modes[mode]?.colors ?? {};
          expect(reading.fill).toBe(rgb(colors['rgb-table-header-fill']));
        }
        await page.keyboard.press('Escape');
      }
      /** ClickHouse keeps LibreChat's 1rem space around its own, taller text line; half the space
       *  takes half of it off each side of the header line. */
      expect(spaces['clickhouse-light']).toBe(spaces['default-light']);
      expect(spaces['dense-light']).toBe(spaces['default-light'] - 8);
    } finally {
      await deleteConversations([conversationId]);
    }
  });
});
