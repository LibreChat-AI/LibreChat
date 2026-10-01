import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { clearUserConversations, deleteConversations, seedConversations } from '../db';
import {
  BASE_FONT_PX,
  MAX_SCALE,
  accountButton,
  appearanceCard,
  closeSettingsButton,
  decreaseButton,
  documentOverflowsHorizontally,
  expectRootFontPx,
  increaseButton,
  openAppearanceSettings,
  pressStepper,
  rootFontPx,
  visible,
  withCollapsedSidebar,
  withStoredScale,
} from './ui-scale.helpers';

/**
 * Scaling the interface moves every boundary in it at once: the drawer/rail
 * breakpoint, the width available to a row of controls, the anchor of a portaled
 * menu, the intrinsic size of an avatar, and the measured height of a
 * virtualized row. These scenarios pin the observations a person makes at the
 * top of the range, where all of those are tightest.
 */

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds, 'element should be laid out').not.toBeNull();
  return bounds!;
}

/** Left and right slack between a control and the card that must contain it. */
async function slackInsideCard(control: Locator) {
  return control.evaluate((element) => {
    const card = element.closest('section');
    if (!card) {
      throw new Error('the control is not inside a settings card');
    }
    const control_ = element.getBoundingClientRect();
    const outer = card.getBoundingClientRect();
    return { left: control_.left - outer.left, right: outer.right - control_.right };
  });
}

test.describe('UI scale layout', () => {
  test('Settings stays open when a step crosses the drawer breakpoint @scenario:ui-scale-settings-survives-the-drawer-breakpoint', async ({
    page,
  }) => {
    /* 800px wide: at 150% the drawer query (768px baseline, scaled) matches, at
       100% it does not, so stepping down crosses the layout mode while the panel
       that owns the stepper is open. The panel used to be mounted by the account
       menu, which the crossing unmounted, closing Settings mid-interaction. */
    await page.setViewportSize({ width: 800, height: 900 });
    await withStoredScale(page, MAX_SCALE);
    await withCollapsedSidebar(page);
    await page.goto('/c/new', { timeout: 10000 });
    await openAppearanceSettings(page);
    await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);

    await pressStepper(page, 'decrease', 3);
    await expectRootFontPx(page, BASE_FONT_PX);
    await expect(closeSettingsButton(page)).toBeVisible();
    await expect(decreaseButton(page)).toBeVisible();

    await pressStepper(page, 'increase', 3);
    await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);
    await expect(closeSettingsButton(page)).toBeVisible();
    await expect(increaseButton(page)).toBeVisible();

    /* Still the same dialog, still dismissible from the keyboard. */
    await page.keyboard.press('Escape');
    await expect(closeSettingsButton(page)).toBeHidden();
  });

  test('Appearance controls stay inside their card on a narrow scaled viewport @scenario:ui-scale-appearance-controls-stay-inside-their-card', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await withStoredScale(page, MAX_SCALE);
    await withCollapsedSidebar(page);
    await page.goto('/c/new', { timeout: 10000 });
    await openAppearanceSettings(page);
    await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);

    const card = appearanceCard(page);
    const controls = [
      card.getByRole('combobox').first(),
      card.getByTestId('ui-scale-decrease'),
      card.getByTestId('ui-scale-increase'),
    ];
    for (const control of controls) {
      await control.scrollIntoViewIfNeeded();
      const slack = await slackInsideCard(control);
      /* A control that overflows its card reports negative slack on that side. */
      expect(slack.left, 'control overflows the card on the left').toBeGreaterThanOrEqual(-1);
      expect(slack.right, 'control overflows the card on the right').toBeGreaterThanOrEqual(-1);
    }
    expect(await documentOverflowsHorizontally(page)).toBe(false);
  });

  test('a portaled menu opens inside the viewport at the top of the range @scenario:ui-scale-portaled-menu-stays-in-the-viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 520, height: 900 });
    await withStoredScale(page, MAX_SCALE);
    await withCollapsedSidebar(page);
    await page.goto('/c/new', { timeout: 10000 });
    await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);

    const account = await accountButton(page);
    await account.click();
    await expect(visible(page, 'nav-settings')).toBeVisible();
    const menu = page.getByRole('menu', { name: 'Account Settings' });
    const bounds = await box(menu);
    const viewport = page.viewportSize()!;
    /* The menu is portaled to the body, so a scale that fed layout through a
       transform instead of the root font size would leave it anchored off the
       viewport, or force the document to scroll sideways. */
    expect(bounds.x).toBeGreaterThanOrEqual(-1);
    expect(bounds.y).toBeGreaterThanOrEqual(-1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(await documentOverflowsHorizontally(page)).toBe(false);
  });

  test('the account avatar grows square with the scale @scenario:ui-scale-avatar-keeps-its-shape', async ({
    page,
  }) => {
    const avatarBox = async (current: Page) => {
      const account = await accountButton(current);
      return box(account.locator('div.rounded-full, img').first());
    };

    await page.goto('/c/new', { timeout: 10000 });
    await expectRootFontPx(page, BASE_FONT_PX);
    const unscaled = await avatarBox(page);
    expect(
      Math.abs(unscaled.width - unscaled.height),
      'avatar should be square',
    ).toBeLessThanOrEqual(1);

    await withStoredScale(page, MAX_SCALE);
    await page.reload({ timeout: 15000 });
    await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);
    const scaled = await avatarBox(page);

    /* A pixel-sized avatar in a scaled flex row gets squeezed into an ellipse;
       an unscaled one stays the same size while its neighbours grow. */
    expect(Math.abs(scaled.width - scaled.height), 'avatar should stay square').toBeLessThanOrEqual(
      1,
    );
    expect(scaled.height / unscaled.height).toBeGreaterThan(1.35);
    expect(scaled.height / unscaled.height).toBeLessThan(1.65);
  });

  test('virtualized conversation rows are remeasured for the new scale @scenario:ui-scale-conversation-rows-are-remeasured', async ({
    page,
  }) => {
    const user = getE2EUser();
    const conversationIds = [randomUUID(), randomUUID(), randomUUID()];
    await clearUserConversations(user.email);
    await seedConversations(
      user.email,
      conversationIds.map((conversationId, index) => ({
        conversationId,
        title: `Scaled row ${index + 1}`,
        updatedAt: new Date(),
      })),
    );

    try {
      await page.goto('/c/new', { timeout: 10000 });
      const firstRow = page.getByTestId('convo-item').first();
      await expect(firstRow).toBeVisible({ timeout: 20000 });
      const unscaledFont = await rootFontPx(page);
      const unscaled = await box(firstRow);

      await withStoredScale(page, MAX_SCALE);
      await page.reload({ timeout: 15000 });
      await expect(firstRow).toBeVisible({ timeout: 20000 });
      await expectRootFontPx(page, unscaledFont * MAX_SCALE);
      const scaled = await box(firstRow);

      /* The rows are measured into a CellMeasurerCache; a cache that is not
         invalidated on a scale change keeps the old heights and clips the
         now-larger titles. */
      expect(scaled.height / unscaled.height).toBeGreaterThan(1.25);
      const clipped = await firstRow.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      );
      expect(clipped, 'the scaled row clips its own content').toBe(false);
    } finally {
      await deleteConversations(conversationIds);
    }
  });
});
