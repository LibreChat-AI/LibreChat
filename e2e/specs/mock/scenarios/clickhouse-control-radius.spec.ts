import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * Controls take the theme's control radius, not a surface-sized step of the radius scale. Under
 * the ClickHouse theme `rounded-xl` is Click UI's dialog step (8px) while its controls are drawn at
 * `radii.1` (4px); in the default theme both are 12px, so the default look does not move. Every
 * expectation is resolved by the browser from a probe carrying the role, never written down here.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

async function storeTheme(page: Page, definition: unknown) {
  await page.addInitScript((stored) => {
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    if (stored) {
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    } else {
      localStorage.removeItem('theme-definition');
      localStorage.removeItem('theme-source');
    }
  }, definition ?? null);
}

const radius = (locator: Locator) =>
  locator.evaluate((node) => getComputedStyle(node).borderTopLeftRadius);

async function openGeneralSettings(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.getByTestId('nav-user').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await dialog.getByRole('tab', { name: 'General' }).click();
  return dialog;
}

async function settingsControlRadii(page: Page) {
  const dialog = await openGeneralSettings(page);
  const select = dialog.getByRole('combobox').first();
  await expect(select).toBeVisible();
  return {
    tab: await radius(dialog.getByRole('tab', { name: 'General' })),
    select: await radius(select),
  };
}

async function marketplaceToolbarRadii(page: Page) {
  await page.goto('/agents/all', { timeout: 15000 });
  const sort = page.getByTestId('agent-sort-dropdown');
  await expect(sort).toBeVisible({ timeout: 30000 });
  const controls: Locator[] = [
    sort,
    page.getByRole('button', { name: 'My agents' }),
    page.getByRole('textbox', { name: 'Search agents' }),
  ];
  const admin = page.getByRole('button', { name: 'Admin Settings' });
  if (await admin.isVisible()) {
    controls.push(admin);
  }
  return Promise.all(controls.map(radius));
}

test.describe('control radius', () => {
  test('settings selects and tabs take the ClickHouse control radius @scenario:clickhouse-settings-controls-take-control-radius', async ({
    page,
  }) => {
    await storeTheme(page, clickHouseTheme);

    const radii = await settingsControlRadii(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    const control = await probeStyle(page, 'rounded-theme-control', 'border-top-left-radius');
    const dialogStep = await probeStyle(page, 'rounded-xl', 'border-top-left-radius');

    /** `border.radii.1`, and not the dialog step these controls used to borrow. */
    expect(control).toBe('4px');
    expect(dialogStep).not.toBe(control);
    expect(radii).toEqual({ tab: control, select: control });
  });

  test('the default theme keeps its settings control corners @scenario:default-theme-settings-controls-keep-radius', async ({
    page,
  }) => {
    await storeTheme(page, null);

    const radii = await settingsControlRadii(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'clickhouse');
    const previous = await probeStyle(page, 'rounded-xl', 'border-top-left-radius');

    expect(previous).toBe('12px');
    expect(radii).toEqual({ tab: previous, select: previous });
  });

  test('the marketplace toolbar controls share one corner in every theme @scenario:marketplace-toolbar-shares-one-radius', async ({
    page,
  }) => {
    for (const definition of [null, clickHouseTheme]) {
      await storeTheme(page, definition);
      const radii = await marketplaceToolbarRadii(page);
      const button = await probeStyle(page, 'rounded-lg', 'border-top-left-radius');

      expect(radii.length).toBeGreaterThanOrEqual(3);
      expect(new Set(radii)).toEqual(new Set([button]));
    }
  });
});
