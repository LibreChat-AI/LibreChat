import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The measured band outlives the chat screen on purpose — a second chat column
 * reads it rather than remeasuring — and the screens it outlives can change it:
 * the auth layout carries a theme selector, and a contrast switch there widens
 * the app's own scrollbar while nothing is watching. So the chat screen has to
 * remeasure on arrival rather than trust what it finds.
 */

const COMPOSER = '[data-testid="composer-surface"]';
/** Nothing the platform would ever reserve; only a stale value looks like this. */
const STALE_GUTTER = '40px';

test.use({ viewport: { width: 1280, height: 800 } });

/** Leave a stale reservation behind, the way another screen would have. */
async function withStaleGutter(page: Page) {
  await page.addInitScript((value) => {
    const apply = () => {
      document.documentElement.style.setProperty('--message-scrollbar-gutter', value);
    };
    if (document.documentElement) {
      apply();
    }
    document.addEventListener('readystatechange', apply, { once: true });
  }, STALE_GUTTER);
}

const measured = (page: Page) =>
  page.evaluate(() => {
    const surface = document.querySelector('[data-testid="composer-surface"]');
    const column = surface?.closest('form')?.parentElement;
    if (!surface || !column) {
      throw new Error('the composer column is not rendered');
    }
    return {
      published: getComputedStyle(document.documentElement)
        .getPropertyValue('--message-scrollbar-gutter')
        .trim(),
      composerRight: Math.round(surface.getBoundingClientRect().right),
      columnRight: Math.round(column.getBoundingClientRect().right),
    };
  });

test.describe('stale gutter', () => {
  test('the welcome screen remeasures a band it did not measure @scenario:welcome-screen-remeasures-a-stale-gutter', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await withStaleGutter(page);

    await page.goto('/c/new', { timeout: 10000 });
    await expect(page.locator(COMPOSER)).toBeVisible();
    await page.waitForTimeout(600);

    const state = await measured(page);
    expect(state.published, 'the stale reservation was kept').not.toBe(STALE_GUTTER);
    /** 40px of phantom scrollbar would push the composer that far off its column. */
    expect(state.columnRight - state.composerRight).toBeLessThanOrEqual(16);
  });
});
