import { expect, test } from '@playwright/test';
import {
  BASE_FONT_PX,
  decreaseButton,
  expectRootFontPx,
  increaseButton,
  openAppearanceSettings,
  pressStepper,
  recordRootFontChanges,
  recordedRootFontChanges,
  scaleReadout,
  withStoredScale,
} from './ui-scale.helpers';

/**
 * Settings > General > Appearance > UI scale is a stepper over the browser's own
 * Ctrl -/+ ladder. Its contract is about what the person operating it sees: the
 * readout answers the click straight away, the interface itself reflows once the
 * clicking stops, the ends of the range are dead, and a value that is not on a
 * stop is stepped back onto one.
 */

test.describe('UI scale stepper', () => {
  test('the readout answers a step before the interface reflows @scenario:ui-scale-readout-answers-each-step', async ({
    page,
  }) => {
    await page.goto('/c/new', { timeout: 10000 });
    await openAppearanceSettings(page);
    await expect(scaleReadout(page)).toHaveText('100%');

    await increaseButton(page).click();
    /* The readout is the acknowledgement; the reflow is deliberately held back,
       so the next stop is readable while the layout is still at the old size. */
    await expect(scaleReadout(page)).toHaveText('110%');

    await expectRootFontPx(page, BASE_FONT_PX * 1.1);
    await expect(scaleReadout(page)).toHaveText('110%');

    await decreaseButton(page).click();
    await expect(scaleReadout(page)).toHaveText('100%');
    await expectRootFontPx(page, BASE_FONT_PX);
  });

  test('a burst of steps reflows once, at the last stop @scenario:ui-scale-burst-of-steps-reflows-once', async ({
    page,
  }) => {
    await page.goto('/c/new', { timeout: 10000 });
    await openAppearanceSettings(page);
    await expect(scaleReadout(page)).toHaveText('100%');

    await recordRootFontChanges(page);
    /* 100 -> 110 -> 125. Keyboard steps stay inside the coalescing window, so
       the intermediate 110% must never reach the page. */
    await pressStepper(page, 'increase', 2);
    await expect(scaleReadout(page)).toHaveText('125%');

    await expectRootFontPx(page, BASE_FONT_PX * 1.25);
    expect(await recordedRootFontChanges(page)).toEqual(['16px', '20px']);
  });

  test('the stepper is dead at both ends of its range @scenario:ui-scale-stops-at-both-range-ends', async ({
    page,
  }) => {
    await withStoredScale(page, 0.5);
    await page.goto('/c/new', { timeout: 10000 });
    await openAppearanceSettings(page);

    await expect(scaleReadout(page)).toHaveText('50%');
    await expect(decreaseButton(page)).toBeDisabled();
    await expect(increaseButton(page)).toBeEnabled();
    await expectRootFontPx(page, BASE_FONT_PX * 0.5);

    /* Eight stops from 50% to 150%; the top has to stop offering more. */
    await pressStepper(page, 'increase', 8);
    await expect(scaleReadout(page)).toHaveText('150%');
    await expectRootFontPx(page, BASE_FONT_PX * 1.5);
    await expect(increaseButton(page)).toBeDisabled();
    await expect(decreaseButton(page)).toBeEnabled();
  });

  test('a stored value off the ladder steps back onto it @scenario:ui-scale-off-stop-value-snaps-to-a-stop', async ({
    page,
  }) => {
    /* Nothing in the UI can produce 137%; a hand-edited or migrated value can. */
    await withStoredScale(page, 1.37);
    await page.goto('/c/new', { timeout: 10000 });
    await expectRootFontPx(page, BASE_FONT_PX * 1.37);

    await openAppearanceSettings(page);
    await expect(scaleReadout(page)).toHaveText('137%');

    await decreaseButton(page).click();
    await expect(scaleReadout(page)).toHaveText('125%');
    await expectRootFontPx(page, BASE_FONT_PX * 1.25);

    await increaseButton(page).click();
    await expect(scaleReadout(page)).toHaveText('150%');
    await expectRootFontPx(page, BASE_FONT_PX * 1.5);
  });
});
