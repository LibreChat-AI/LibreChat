import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The account menu and its help submenu are `.popover-ui` panels, whose rule draws the menu radius
 * role, so the `rounded-lg` they also carried never painted. The default theme keeps the menu
 * corner they have always shown, ClickHouse brings them onto its menu corner, and a reference theme
 * that names only `menuRadius` reshapes them, with no rule written for the account menu itself.
 * Every expected corner is resolved by the browser from a probe.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const REFERENCE_RADIUS = '3px';

const referenceTheme = {
  version: 1,
  name: 'menu-radius-reference',
  modes: {
    light: { appearance: { menuRadius: REFERENCE_RADIUS } },
    dark: { appearance: { menuRadius: REFERENCE_RADIUS } },
  },
};

type ThemeChoice = 'default' | 'clickhouse' | 'reference';

const definitions: Record<Exclude<ThemeChoice, 'default'>, object> = {
  clickhouse: clickHouseTheme,
  reference: referenceTheme,
};

async function openNewChat(page: Page, theme: ThemeChoice) {
  await page.addInitScript(
    (definition) => {
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (definition === null) {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
        return;
      }
      localStorage.setItem('theme-definition', JSON.stringify(definition));
      localStorage.setItem('theme-source', 'definition');
    },
    theme === 'default' ? null : definitions[theme],
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByTestId('text-input')).toBeVisible({ timeout: 30000 });
}

const cornerOf = (locator: Locator) =>
  locator.evaluate((node) => getComputedStyle(node).borderTopLeftRadius);

/** Open the account menu, then its help submenu, and read both panels' corners. */
async function accountPanelCorners(page: Page) {
  await page.getByTestId('nav-user').click();
  const accountMenu = page.getByRole('menu').filter({ has: page.getByTestId('nav-settings') });
  await expect(accountMenu).toBeVisible();
  const account = await cornerOf(accountMenu);

  await page.getByRole('menuitem', { name: 'Help' }).click();
  const helpMenu = page.getByRole('menu').filter({ hasNot: page.getByTestId('nav-settings') });
  await expect(helpMenu).toBeVisible();
  const help = await cornerOf(helpMenu);
  return { account, help };
}

test.describe('account menu panel shape', () => {
  test('the default theme keeps the account menu corners @scenario:default-theme-account-panels-unchanged', async ({
    page,
  }) => {
    await openNewChat(page, 'default');
    const menuCorner = await probeStyle(page, 'popover-ui', 'border-top-left-radius');
    const corners = await accountPanelCorners(page);

    expect(menuCorner).toBe('11.2px');
    expect(corners).toEqual({ account: menuCorner, help: menuCorner });
  });

  test('ClickHouse brings the account menus onto its menu corner @scenario:clickhouse-account-panels-follow-menu-corner', async ({
    page,
  }) => {
    await openNewChat(page, 'clickhouse');
    const menuCorner = await probeStyle(page, 'popover-ui', 'border-top-left-radius');
    const corners = await accountPanelCorners(page);

    expect(menuCorner).toBe('4px');
    expect(corners).toEqual({ account: menuCorner, help: menuCorner });
  });

  test('a theme naming only the menu radius role reshapes the account menus @scenario:reference-theme-reshapes-account-panels', async ({
    page,
  }) => {
    await openNewChat(page, 'reference');
    const corners = await accountPanelCorners(page);

    expect(corners).toEqual({ account: REFERENCE_RADIUS, help: REFERENCE_RADIUS });
  });
});
