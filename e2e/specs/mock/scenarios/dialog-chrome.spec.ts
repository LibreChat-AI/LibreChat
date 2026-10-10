import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ThemeDefinition } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * An OGDialog reads its edge stroke, inline padding and title type from theme roles. The Data &
 * Privacy tab's "Confirm Archive" dialog is a plain OGDialogTemplate with no chrome of its own,
 * so it shows what the primitive draws.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';

/** A definition from before the dialog roles, which set only the UI type and the body ink. */
const legacyTypeTheme: ThemeDefinition = {
  version: 1,
  name: 'legacy-type-reference',
  modes: {
    light: {
      colors: { 'rgb-text-primary': '10 20 30' },
      appearance: { fontFamily: 'Georgia, serif', textLg: '1.4rem' },
    },
    dark: {
      colors: { 'rgb-text-primary': '10 20 30' },
      appearance: { fontFamily: 'Georgia, serif', textLg: '1.4rem' },
    },
  },
};

async function storeDefinition(page: Page, definition: ThemeDefinition | null) {
  await page.addInitScript((stored) => {
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored === null) {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
      return;
    }
    localStorage.setItem('theme-definition', JSON.stringify(stored));
    localStorage.setItem('theme-source', 'definition');
  }, definition);
}

async function confirmArchiveDialog(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await settings.getByRole('tab', { name: 'Data & Privacy' }).click();
  await settings.getByRole('button', { name: 'Archive all chats' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm Archive' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const chrome = (dialog: Locator) =>
  dialog.evaluate((node: HTMLElement) => {
    const surface = getComputedStyle(node);
    const title = getComputedStyle(node.querySelector('h2') as HTMLElement);
    return {
      stroke: surface.borderTopWidth,
      strokeColor: surface.borderTopColor,
      paddingX: surface.paddingLeft,
      titleSize: title.fontSize,
      titleLeading: title.lineHeight,
      titleWeight: title.fontWeight,
      titleFamily: title.fontFamily,
      titleColor: title.color,
    };
  });

const resolvedMode = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  ) as Promise<Mode>;

test.describe('theme dialog chrome', () => {
  test('dialogs keep no edge, 24px padding and an 18px semibold title without a theme @scenario:dialogs-keep-default-chrome', async ({
    page,
  }) => {
    await storeDefinition(page, null);
    const dialog = await confirmArchiveDialog(page);
    const drawn = await chrome(dialog);

    expect(drawn).toMatchObject({
      stroke: '0px',
      paddingX: '24px',
      titleSize: '18px',
      titleLeading: '18px',
      titleWeight: '600',
    });
    expect(drawn.titleFamily).toBe(await probeStyle(page, 'font-display', 'font-family'));
    expect(drawn.titleColor).toBe(await probeStyle(page, 'text-text-primary', 'color'));
  });

  test('ClickHouse dialogs take Click UI stroke, padding and title @scenario:clickhouse-dialogs-follow-click-ui', async ({
    page,
  }) => {
    await storeDefinition(page, clickHouseTheme);
    const dialog = await confirmArchiveDialog(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    const mode = await resolvedMode(page);
    const drawn = await chrome(dialog);

    /** `dialog.stroke.default`, `dialog.space.x` and `dialog.typography.title.default`. */
    expect(drawn).toMatchObject({
      stroke: '1px',
      strokeColor: mode === 'light' ? 'rgb(230, 231, 233)' : 'rgb(50, 50, 50)',
      paddingX: '32px',
      titleSize: '20px',
      titleLeading: '30px',
      titleWeight: '700',
      titleColor: mode === 'light' ? 'rgb(30, 29, 31)' : 'rgb(249, 249, 249)',
    });
    /** The regular family, not the display one ClickHouse headings use. */
    expect(drawn.titleFamily.split(',')[0].replace(/"/g, '')).toBe('Inter');
  });

  test('a theme that sets only its type and body ink keeps its dialog titles on them @scenario:legacy-type-theme-keeps-dialog-title', async ({
    page,
  }) => {
    await storeDefinition(page, legacyTypeTheme);
    const dialog = await confirmArchiveDialog(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'legacy-type-reference');
    const drawn = await chrome(dialog);

    expect(drawn.titleFamily).toBe('Georgia, serif');
    expect(drawn.titleSize).toBe('22.4px');
    expect(drawn.titleColor).toBe('rgb(10, 20, 30)');
  });
});
