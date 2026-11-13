import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { openPanel } from './panels';

/**
 * The schedule dialog centers itself with the `translate` property, which makes it the containing
 * block of the `position: fixed` picker popovers rendered inside it. A popover placed as if it were
 * relative to the viewport lands the dialog's own offset away from the field that opened it, so each
 * scenario measures the popover against that field.
 */

async function openScheduleDialog(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await openPanel(page, 'schedules', 'Scheduled chats');
  const panel = page.getByRole('region', { name: 'Scheduled chats', exact: true });
  await panel.getByRole('button', { name: 'New schedule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The popover surface holding a picker column, wherever it is rendered. */
function popoverOf(page: Page, column: string): Locator {
  return page
    .getByRole('radiogroup', { name: column, exact: true })
    .locator('xpath=ancestor::*[@role="dialog"][1]');
}

/**
 * How far an opened popover sits from the field that opened it: `gap` to the edge of the field it
 * faces (Radix offsets it 6px, below the field or above it when the dialog has no room below) and
 * `shift` between their left edges (the popover is start aligned). The box is read once the enter
 * animation has ended, because the surface zooms in from 95%.
 */
async function measure(field: Locator, popover: Locator) {
  await popover.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => null))),
  );
  const anchor = await field.boundingBox();
  const surface = await popover.boundingBox();
  if (anchor == null || surface == null) {
    return { gap: Infinity, shift: Infinity };
  }
  return {
    gap: Math.min(
      Math.abs(surface.y - (anchor.y + anchor.height)),
      Math.abs(anchor.y - (surface.y + surface.height)),
    ),
    shift: Math.abs(surface.x - anchor.x),
  };
}

async function expectBesideField(field: Locator, popover: Locator) {
  await expect(popover).toBeVisible();
  await expect.poll(async () => (await measure(field, popover)).gap).toBeLessThanOrEqual(8);
  await expect.poll(async () => (await measure(field, popover)).shift).toBeLessThanOrEqual(2);
}

test.describe('schedule time pickers', () => {
  test('the Weekly time popover opens against its field @scenario:schedule-time-popover-beside-field', async ({
    page,
  }) => {
    const dialog = await openScheduleDialog(page);
    await dialog.getByRole('radio', { name: 'Weekly', exact: true }).click();
    const field = dialog.getByRole('button', { name: /^Time\b/ });
    await field.click();
    await expectBesideField(field, popoverOf(page, 'Hour'));
  });

  test('the Hourly minute popover opens against its field @scenario:schedule-minute-popover-beside-field', async ({
    page,
  }) => {
    const dialog = await openScheduleDialog(page);
    await dialog.getByRole('radio', { name: 'Hourly', exact: true }).click();
    const field = dialog.getByRole('button', { name: /^Minutes past the hour/ });
    await field.click();
    await expectBesideField(field, popoverOf(page, 'Minute'));
  });

  test('a dialog scrolled by its own overflow keeps the time popover against its field @scenario:schedule-time-popover-scrolled-dialog', async ({
    page,
  }) => {
    /** A viewport shorter than the form, so the field sits below the fold of the dialog. */
    await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: 480 });
    const dialog = await openScheduleDialog(page);
    await dialog.getByRole('radio', { name: 'Weekly', exact: true }).click();
    const field = dialog.getByRole('button', { name: /^Time\b/ });
    await field.scrollIntoViewIfNeeded();
    await expect.poll(() => dialog.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await field.click();
    await expectBesideField(field, popoverOf(page, 'Hour'));
  });
});
