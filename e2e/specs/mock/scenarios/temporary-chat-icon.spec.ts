import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Temporary chat is a retention mode, and it was marked with a dashed speech
 * bubble that reads as a generic chat glyph. It now carries lucide's
 * hat-and-glasses incognito mark, on the toggle that turns it on and on the
 * welcome screen that explains it.
 */

const INCOGNITO = 'svg.lucide-hat-glasses';
const TOGGLE = 'button[aria-label="Temporary Chat"]';

test.describe('temporary chat mark', () => {
  test('turning temporary chat on marks it with the incognito icon @scenario:temporary-chat-marked-with-incognito-icon', async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width < 768, 'the header toggle collapses into the overflow menu below md');

    await page.goto('/c/new', { timeout: 10000 });
    const toggle = page.locator(TOGGLE);
    await expect(toggle).toBeVisible({ timeout: 20000 });
    await expect(toggle.locator(INCOGNITO)).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    /** The welcome screen takes over the explanation, under the same mark. */
    await expect(page.getByText('Temporary Chat', { exact: true }).first()).toBeVisible();
    await expect(page.locator(INCOGNITO)).toHaveCount(2);
    expect(await strokeOnly(page)).toBe(true);

    /** Leave the account as the suite found it: the mode is persisted locally. */
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});

/** The mark is a lucide outline icon: it follows the text colour rather than
 *  painting a filled shape that would ignore the theme. */
async function strokeOnly(page: Page): Promise<boolean> {
  return page.evaluate((selector) => {
    const icons = Array.from(document.querySelectorAll(selector));
    return (
      icons.length > 0 &&
      icons.every((icon) => {
        const style = getComputedStyle(icon);
        return style.fill === 'none' && style.stroke !== 'none';
      })
    );
  }, INCOGNITO);
}
