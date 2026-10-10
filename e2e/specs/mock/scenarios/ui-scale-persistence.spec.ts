import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { clearUserConversations, deleteConversations, seedConversations } from '../db';
import {
  BASE_FONT_PX,
  MAX_SCALE,
  expectRootFontPx,
  conversationRow,
  withStoredScale,
} from './ui-scale.helpers';

/**
 * The scale is a persisted preference, not a session toggle: it has to be in
 * force on the first frame the interface paints, survive a reload and in-app
 * navigation, and compose with (never replace) the reader's own browser font
 * size preference.
 */

type PaintSample = { fontSize: string; painted: boolean };

/**
 * Sample the root font size on every frame from before the document runs, next
 * to whether the app has painted anything yet. "No flash at the wrong size" is
 * exactly the claim that no painted frame was ever unscaled.
 */
async function recordPaintSamples(page: Page) {
  await page.addInitScript(() => {
    const samples: { fontSize: string; painted: boolean }[] = [];
    window.__uiScalePaintSamples = samples;
    const tick = () => {
      const root = document.getElementById('root');
      samples.push({
        fontSize: getComputedStyle(document.documentElement).fontSize,
        painted: !!root && root.childElementCount > 0,
      });
      if (samples.length < 600) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

async function paintSamples(page: Page): Promise<PaintSample[]> {
  return page.evaluate(() => window.__uiScalePaintSamples ?? []);
}

declare global {
  interface Window {
    /** Frame-by-frame root font size and paint state, for the first-paint scenario. */
    __uiScalePaintSamples?: { fontSize: string; painted: boolean }[];
  }
}

test.describe('UI scale persistence', () => {
  test('a scaled interface never paints an unscaled frame @scenario:ui-scale-never-paints-an-unscaled-frame', async ({
    page,
  }) => {
    await withStoredScale(page, MAX_SCALE);
    await recordPaintSamples(page);
    await page.goto('/c/new', { timeout: 10000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 20000,
    });
    await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);

    const samples = await paintSamples(page);
    const painted = samples.filter((sample) => sample.painted);
    expect(painted.length).toBeGreaterThan(0);
    /* Every frame that had interface in it was already at 24px. A late bootstrap
       would leave 16px frames in here, which is the flash this guards. */
    expect([...new Set(painted.map((sample) => sample.fontSize))]).toEqual(['24px']);
  });

  test('the scale survives a reload and in-app navigation @scenario:ui-scale-survives-reload-and-navigation', async ({
    page,
  }) => {
    const user = getE2EUser();
    const conversationId = randomUUID();
    await clearUserConversations(user.email);
    await seedConversations(user.email, [
      { conversationId, title: 'Scaled navigation target', updatedAt: new Date() },
    ]);

    try {
      await withStoredScale(page, MAX_SCALE);
      await page.goto('/c/new', { timeout: 10000 });
      await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);

      await page.reload({ timeout: 15000 });
      await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);

      /* Navigating inside the SPA re-mounts the shell; the scale lives above it.
         Below the drawer breakpoint the list is behind the drawer. */
      const row = await conversationRow(page, 'Scaled navigation target');
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/c/${conversationId}$`));
      await expectRootFontPx(page, BASE_FONT_PX * MAX_SCALE);
    } finally {
      await deleteConversations([conversationId]);
    }
  });

  test("the scale multiplies the reader's own font size instead of replacing it @scenario:ui-scale-keeps-the-browser-font-preference", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'the font-size preference is set over CDP');

    await withStoredScale(page, MAX_SCALE);
    const cdp = await page.context().newCDPSession(page);
    /* A reader who has set their browser's default text size to 20px. */
    await cdp.send('Page.setFontSizes', { fontSizes: { standard: 20, fixed: 13 } });

    await page.goto('/c/new', { timeout: 10000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 20000,
    });
    /* 20px preference x 150% scale. Hard-coding 16px in the root rule would
       silently discard the preference and land on 24px. */
    await expectRootFontPx(page, 30);
    await cdp.detach();
  });
});
