import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The panels share one empty card: a bordered box with a circular icon, a title
 * and a line of explanation. The prompts panel drew its own copy of it, a shade
 * off on the border, so an empty prompts list did not look like an empty
 * bookmarks or memories list.
 */

type CardStyle = {
  borderColor: string;
  borderWidth: string;
  borderRadius: string;
  padding: string;
  textAlign: string;
  iconBackground: string;
};

test.describe('empty panel cards', () => {
  test('the empty prompts panel is drawn like the other panels @scenario:empty-prompts-panel-matches-other-panels', async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width < 768, 'the side panels open as a drawer below md');

    await page.goto('/c/new', { timeout: 10000 });

    const prompts = await openPanelCard(page, 'Prompts', 'No prompts yet');
    const bookmarks = await openPanelCard(page, 'Bookmarks', 'No bookmarks yet');

    expect(prompts).toEqual(bookmarks);
  });
});

/** Open a side panel from the rail and measure the empty card it renders. */
async function openPanelCard(page: Page, panel: string, title: string): Promise<CardStyle> {
  await page.getByRole('button', { name: panel }).first().click();
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 20000 });

  return page.evaluate((heading) => {
    const label = Array.from(document.querySelectorAll('p')).find(
      (node) => node.textContent?.trim() === heading,
    );
    const card = label?.parentElement;
    const icon = card?.firstElementChild;
    if (!card || !icon) {
      throw new Error(`the ${heading} card is not rendered`);
    }
    const style = getComputedStyle(card);
    return {
      borderColor: style.borderColor,
      borderWidth: style.borderWidth,
      borderRadius: style.borderRadius,
      padding: style.padding,
      textAlign: style.textAlign,
      iconBackground: getComputedStyle(icon).backgroundColor,
    };
  }, title);
}
