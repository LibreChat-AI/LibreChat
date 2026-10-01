import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ThemeDefinition } from '../../../../packages/client/src/theme/types';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The shared Button reads its label weight, its default and small heights and its primary fill
 * from theme roles. The Data & Privacy tab's "Archive all chats" button is a plain default-size Button with
 * no weight or height of its own, so it shows what the primitive draws.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

type Mode = 'light' | 'dark';

/** A definition from before the button roles, which repainted only the inverted surface. */
const legacyInvertedTheme: ThemeDefinition = {
  version: 1,
  name: 'legacy-inverted-reference',
  modes: {
    light: { colors: { 'rgb-surface-inverted': '10 20 30' } },
    dark: { colors: { 'rgb-surface-inverted': '10 20 30' } },
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

async function archiveButton(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: 'Data & Privacy' }).click();
  const button = dialog.getByRole('button', { name: 'Archive all chats' });
  await expect(button).toBeVisible();
  return button;
}

/** Layout height, not the client rect: the dialog may still be zooming in when this reads. */
const drawn = (button: Locator) =>
  button.evaluate((node: HTMLElement) => ({
    weight: getComputedStyle(node).fontWeight,
    height: node.offsetHeight,
  }));

const resolvedMode = (page: Page) =>
  page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  ) as Promise<Mode>;

test.describe('theme button roles', () => {
  test('buttons keep a 500 label, 40px height and the inverted fill without a theme @scenario:buttons-keep-default-weight-height-and-fill', async ({
    page,
  }) => {
    await storeDefinition(page, null);
    const button = await archiveButton(page);

    expect(await drawn(button)).toEqual({ weight: '500', height: 40 });
    expect(await probeStyle(page, 'h-theme-button-sm', 'height')).toBe('36px');
    expect(await probeStyle(page, 'bg-button-primary', 'background-color')).toBe(
      await probeStyle(page, 'bg-surface-inverted', 'background-color'),
    );
    expect(await probeStyle(page, 'bg-button-primary-hover', 'background-color')).toBe(
      await probeStyle(page, 'bg-surface-inverted-hover', 'background-color'),
    );
  });

  test('ClickHouse buttons take Click UI weight, height and primary fill @scenario:clickhouse-buttons-follow-click-ui', async ({
    page,
  }) => {
    await storeDefinition(page, clickHouseTheme);
    const button = await archiveButton(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    const mode = await resolvedMode(page);

    /** `button.basic.typography.label.default` is 400; Click UI's content-sized button is 32px. */
    expect(await drawn(button)).toEqual({ weight: '400', height: 32 });
    expect(await probeStyle(page, 'h-theme-button-sm', 'height')).toBe('32px');
    /** The button's own primary fill; the checkbox and switch keep `#151515` in light. */
    const fill = mode === 'light' ? 'rgb(48, 46, 50)' : 'rgb(250, 255, 105)';
    const inverted = mode === 'light' ? 'rgb(21, 21, 21)' : 'rgb(250, 255, 105)';
    expect(await probeStyle(page, 'bg-button-primary', 'background-color')).toBe(fill);
    expect(await probeStyle(page, 'bg-surface-inverted', 'background-color')).toBe(inverted);
  });

  test('a theme that repaints only the inverted surface keeps its buttons on it @scenario:legacy-inverted-theme-keeps-button-fill', async ({
    page,
  }) => {
    await storeDefinition(page, legacyInvertedTheme);
    await archiveButton(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'legacy-inverted-reference');

    expect(await probeStyle(page, 'bg-button-primary', 'background-color')).toBe('rgb(10, 20, 30)');
  });
});
