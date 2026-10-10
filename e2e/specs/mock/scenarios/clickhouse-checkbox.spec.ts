import { expect, test } from '@playwright/test';
import { FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';

/**
 * The shared checkbox reads its corner from `checkboxRadius` and, under `checkboxFillStyle:
 * 'fill'`, paints an unchecked box in `checkbox-fill`. Click UI fills the box with
 * `checkbox.color.background.default` and rounds it at `checkbox.radii.all` (0.125rem); LibreChat's
 * own checkbox stays clear on the `rounded-sm` corner without a theme. The My Files table's row
 * selection is a real consumer of the primitive, with a routed file list.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';
type ThemeChoice = 'clickhouse' | 'default' | 'small-corner' | 'fill-canvas';

/** Names only the small corner, as a theme written before the checkbox had a role of its own. */
const smallCornerTheme = {
  version: 1,
  name: 'e2e-small-corner',
  modes: { light: { appearance: { radiusSm: '6px' } }, dark: { appearance: { radiusSm: '6px' } } },
};

/** Fills the checkbox without naming its fill, so the box takes the theme's own canvas. */
const fillCanvasTheme = {
  version: 1,
  name: 'e2e-checkbox-fill-canvas',
  modes: {
    light: {
      colors: { 'rgb-surface-primary': '10 20 30' },
      appearance: { checkboxFillStyle: 'fill' },
    },
  },
};

const files: TFile[] = Array.from({ length: 2 }, (_, index) => ({
  file_id: `checkbox-theme-file-${index}`,
  filename: `Checkbox theme fixture ${index}.txt`,
  filepath: `/files/checkbox-theme-file-${index}.txt`,
  user: 'checkbox-theme-user',
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
    {
      clickhouse: clickHouseTheme,
      'small-corner': smallCornerTheme,
      'fill-canvas': fillCanvasTheme,
    },
  );
}

async function openFiles(page: Page, theme: ThemeChoice, mode: Mode) {
  await page.goto(`/c/new?e2eTheme=${theme}&e2eThemeMode=${mode}`, { timeout: 15000 });
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
  await page.getByTestId('nav-user').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'My Files' });
  await expect(dialog.getByText(files[0].filename)).toBeVisible();
  return dialog;
}

const paint = (box: Locator) =>
  box.evaluate((node) => {
    const style = getComputedStyle(node);
    return { fill: style.backgroundColor, corner: style.borderTopLeftRadius };
  });

/** The fill a probe painted with `bg-<role>` resolves to on this page. */
const roleFill = (page: Page, role: string) =>
  page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.className = `bg-${name}`;
    document.body.append(probe);
    const fill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return fill;
  }, role);

async function attachShot(dialog: Locator, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await dialog.locator('table').screenshot({ path, animations: 'disabled' });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

const rgb = (triplet: string | undefined) => `rgb(${(triplet ?? '').split(' ').join(', ')})`;

test.describe('theme checkbox', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/files', (route) => route.fulfill({ json: files }));
    await installThemeBridge(page);
  });

  for (const mode of ['light', 'dark'] as Mode[]) {
    test(`ClickHouse ${mode} checkboxes take the Click UI fill and corner @scenario:clickhouse-checkbox-${mode}`, async ({
      page,
    }) => {
      const dialog = await openFiles(page, 'clickhouse', mode);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
      const colors = clickHouseTheme.modes[mode]?.colors ?? {};
      const row = dialog.locator('tbody').getByRole('checkbox').first();

      expect(await paint(row)).toEqual({ fill: rgb(colors['rgb-checkbox-fill']), corner: '2px' });
      await attachShot(dialog, `clickhouse-${mode}-unchecked`);

      await row.click();
      await expect(row).toHaveAttribute('data-state', 'checked');
      expect(await paint(row)).toEqual({
        fill: rgb(colors['rgb-surface-inverted']),
        corner: '2px',
      });
      await attachShot(dialog, `clickhouse-${mode}-checked`);
    });

    test(`default ${mode} checkboxes stay clear on the small corner @scenario:default-checkbox-${mode}-unchanged`, async ({
      page,
    }) => {
      const dialog = await openFiles(page, 'default', mode);
      const row = dialog.locator('tbody').getByRole('checkbox').first();

      expect(await paint(row)).toEqual({ fill: 'rgba(0, 0, 0, 0)', corner: '4px' });

      await row.click();
      await expect(row).toHaveAttribute('data-state', 'checked');
      expect((await paint(row)).fill).toBe(await roleFill(page, 'surface-inverted'));
    });
  }

  test('a theme that names only the small corner rounds the checkbox with it @scenario:checkbox-corner-follows-radius-sm', async ({
    page,
  }) => {
    const dialog = await openFiles(page, 'small-corner', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', smallCornerTheme.name);

    expect(await paint(dialog.locator('tbody').getByRole('checkbox').first())).toEqual({
      fill: 'rgba(0, 0, 0, 0)',
      corner: '6px',
    });
  });

  test('a filled theme that names no checkbox fill paints its own canvas @scenario:checkbox-fill-follows-canvas', async ({
    page,
  }) => {
    const dialog = await openFiles(page, 'fill-canvas', 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', fillCanvasTheme.name);

    expect((await paint(dialog.locator('tbody').getByRole('checkbox').first())).fill).toBe(
      'rgb(10, 20, 30)',
    );
  });
});
