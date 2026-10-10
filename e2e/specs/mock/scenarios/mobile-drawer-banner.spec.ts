import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * A site banner sits above the app and stays put while the drawer opens. The drawer opens inside
 * the app below it, as the scrim and the conversation pane already do, so the banner never covers
 * the drawer's header strip: the close toggle, the panel switcher, New chat and the account menu
 * stay visible and tappable.
 *
 * Every scenario loads at phone width rather than resizing into it (berry-13/LibreChat#205).
 */

const DRAWER = '#mobile-drawer';
const BANNER_TEXT = 'Scheduled maintenance tonight';

type Mode = 'light' | 'dark';

test.use({ viewport: { width: 390, height: 844 } });

async function openDrawer(page: Page, mode: Mode, withBanner: boolean) {
  await page.addInitScript((appearance) => {
    localStorage.setItem('color-theme', appearance);
    localStorage.removeItem('theme-definition');
    localStorage.removeItem('theme-source');
    localStorage.removeItem('hideBannerHint');
  }, mode);
  /** The banner is the deployment's; this page alone is served one. */
  await page.route('**/api/banner', (route) =>
    route.fulfill({
      json: withBanner
        ? {
            bannerId: 'e2e-drawer-banner',
            message: `<p>${BANNER_TEXT}</p>`,
            displayFrom: new Date(Date.now() - 60_000).toISOString(),
            displayTo: new Date(Date.now() + 3_600_000).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isPublic: false,
            persistable: true,
          }
        : null,
    }),
  );
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /\bdark\b/ : /\blight\b/);
  if (withBanner) {
    await expect(page.getByText(BANNER_TEXT)).toBeVisible();
  }

  const drawer = page.locator(DRAWER);
  if (!(await drawer.getByTestId('close-sidebar-button').isVisible())) {
    await page.getByTestId('header-open-sidebar-button').click();
  }
  await expect(drawer.getByTestId('close-sidebar-button')).toBeVisible();
  await expect(drawer).not.toHaveAttribute('inert');
  await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1, { timeout: 5000 }).toBe(0);
  return drawer;
}

/** The element a tap at the center of `selector` would land on, and whether it is that control. */
async function tapTarget(page: Page, selector: string) {
  return page.evaluate((target) => {
    const node = document.querySelector(target);
    if (!node) {
      throw new Error(`${target} is not rendered`);
    }
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return node === hit || node.contains(hit);
  }, selector);
}

for (const mode of ['light', 'dark'] as const) {
  const tag =
    mode === 'light'
      ? '@scenario:mobile-drawer-header-below-banner-light'
      : '@scenario:mobile-drawer-header-below-banner-dark';
  test(`the drawer opens below a site banner and its header strip stays tappable (${mode}) ${tag}`, async ({
    page,
  }) => {
    const drawer = await openDrawer(page, mode, true);
    const banner = await page.getByText(BANNER_TEXT).boundingBox();
    const drawerBox = await drawer.boundingBox();
    expect(banner && drawerBox).toBeTruthy();
    /** Below the banner and down to the bottom of the screen. */
    expect(drawerBox!.y).toBeGreaterThanOrEqual(banner!.y + banner!.height - 1);
    expect(drawerBox!.y + drawerBox!.height).toBeCloseTo(844, 0);
    await expect(page.getByText(BANNER_TEXT)).toBeVisible();

    for (const selector of [
      `${DRAWER} [data-testid="close-sidebar-button"]`,
      `${DRAWER} [data-testid="panel-switcher-button"]`,
      `${DRAWER} [data-testid="nav-new-chat-fab"]`,
    ]) {
      expect(await tapTarget(page, selector), `${selector} is covered`).toBe(true);
    }

    await drawer.getByTestId('close-sidebar-button').click();
    await expect(drawer).toHaveAttribute('inert', '');
  });
}

/** The tags are written out whole above; the runner finds a scenario by its literal tag. */
test('without a banner the drawer still covers the whole screen height @scenario:mobile-drawer-full-height-without-banner', async ({
  page,
}) => {
  const drawer = await openDrawer(page, 'light', false);
  const box = await drawer.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBe(0);
  expect(box!.height).toBeCloseTo(844, 0);
  expect(await tapTarget(page, `${DRAWER} [data-testid="close-sidebar-button"]`)).toBe(true);
});
