import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The mobile drawer's trailing edge reads `drawer-edge`. The stock themes keep it on the drawer
 * fill in light and on `border-xheavy` in dark (pinned by the boundary scenarios in
 * `mobile-drawer-controls.spec.ts`); this proves a theme that sets the role repaints the edge.
 */

type Mode = 'light' | 'dark';

const DRAWER = '#mobile-drawer';
const EDGE_THEME = {
  version: 1,
  name: 'drawer-edge-reference',
  modes: {
    light: { colors: { 'rgb-drawer-edge': '200 30 40' } },
    dark: { colors: { 'rgb-drawer-edge': '30 200 40' } },
  },
};

test.use({ viewport: { width: 390, height: 844 } });

async function openDrawer(page: Page, mode: Mode) {
  await page.addInitScript(
    ([appearance, stored]) => {
      localStorage.setItem('color-theme', appearance as string);
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      localStorage.setItem('theme-definition', JSON.stringify(stored));
      localStorage.setItem('theme-source', 'definition');
    },
    [mode, EDGE_THEME] as [string, unknown],
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', EDGE_THEME.name);

  const drawer = page.locator(DRAWER);
  if (!(await drawer.getByTestId('close-sidebar-button').isVisible())) {
    await page.getByTestId('header-open-sidebar-button').click();
  }
  await expect(drawer.getByTestId('close-sidebar-button')).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1, { timeout: 5000 }).toBe(0);
  return drawer;
}

async function readEdge(page: Page, mode: Mode) {
  const drawer = await openDrawer(page, mode);
  return drawer.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.borderRightWidth, color: style.borderRightColor };
  });
}

/** Each tag is written out whole: the runner finds a scenario by its literal tag. */
test.describe('mobile drawer edge role', () => {
  test('a theme that sets drawer-edge repaints the drawer edge in light @scenario:drawer-edge-follows-a-theme-light', async ({
    page,
  }) => {
    expect(await readEdge(page, 'light')).toEqual({ width: '1px', color: 'rgb(200, 30, 40)' });
  });

  test('a theme that sets drawer-edge repaints the drawer edge in dark @scenario:drawer-edge-follows-a-theme-dark', async ({
    page,
  }) => {
    expect(await readEdge(page, 'dark')).toEqual({ width: '1px', color: 'rgb(30, 200, 40)' });
  });
});
