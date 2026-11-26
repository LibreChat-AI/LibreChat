import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
} from '../helpers';

const PALETTE_NAME = 'Attach and tools';
const SEARCH_NAME = 'Search tools, skills and servers';
const FAVORITE_SECTION = 'Favorites';
const TOOL_FAVORITE_PATH = '/api/user/settings/favorites/tools/builtin/execute_code';

const paletteButton = (page: Page) => page.getByRole('button', { name: PALETTE_NAME });
const palette = (page: Page) => page.getByRole('dialog', { name: PALETTE_NAME });
const paletteRows = (page: Page) => palette(page).locator('[data-row-key]');
const paletteSearch = (page: Page) =>
  palette(page).getByRole('combobox', { name: SEARCH_NAME, exact: true });

async function openPalette(page: Page) {
  await expect(paletteButton(page)).toBeVisible();
  await paletteButton(page).click();
  await expect(palette(page)).toBeVisible();
  await expect(paletteSearch(page)).toBeVisible();
}

/**
 * The catalog arrives in waves: built-in tools paint with the dialog, the MCP
 * server list is released by the app-wide warmup timer, and the skills catalog
 * only starts fetching once the dialog's open effect has run. Counting rows the
 * moment the dialog appears therefore snapshots a partial catalog, and the row
 * count keeps climbing underneath the test.
 *
 * Wait for the last wave to land, then for the count to hold still across
 * consecutive reads, and return that settled total.
 */
async function settledRowCount(page: Page): Promise<number> {
  const mcpSection = palette(page).getByRole('columnheader', {
    name: 'MCP Servers',
    exact: true,
  });
  await expect(mcpSection).toBeVisible({ timeout: 20000 });
  const rows = paletteRows(page);
  let previous = -1;
  let stableReads = 0;
  await expect
    .poll(
      async () => {
        const current = await rows.count();
        stableReads = current === previous ? stableReads + 1 : 0;
        previous = current;
        return stableReads;
      },
      { timeout: 20000, intervals: [300] },
    )
    .toBeGreaterThanOrEqual(3);
  return previous;
}

async function selectMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

test.describe('composer palette', () => {
  test('opens one searchable catalog with attach and tool sections @scenario:palette-opens-one-searchable-catalog', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await selectMockChat(page);
    await openPalette(page);

    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(
      palette(page).getByRole('columnheader', { name: 'Attach', exact: true }),
    ).toBeVisible();
    await expect(
      palette(page).getByRole('columnheader', { name: 'Tools', exact: true }),
    ).toBeVisible();
    await expect(
      palette(page).getByRole('button', { name: 'Upload to Provider', exact: true }),
    ).toBeVisible();
    await expect(
      palette(page).getByRole('button', { name: 'Run Code', exact: true }),
    ).toBeVisible();
    await expect(
      palette(page).getByRole('button', { name: 'File Search', exact: true }),
    ).toBeVisible();

    /* Skills and MCP sections depend on the permissions and catalog state supplied
       by the deployment. When present, they are rows in this same dialog rather
       than separate surfaces. */
    const skillsSection = palette(page).getByRole('columnheader', { name: 'Skills', exact: true });
    if ((await skillsSection.count()) > 0) {
      await expect(skillsSection).toBeVisible();
    }
    const mcpSection = palette(page).getByRole('columnheader', {
      name: 'MCP Servers',
      exact: true,
    });
    if ((await mcpSection.count()) > 0) {
      await expect(mcpSection).toBeVisible();
    }

    /* Removed redesign surfaces must be absent from the active palette, not merely
       absent under a legacy test id. */
    await expect(
      palette(page).getByRole('button', { name: 'Tools Options', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Select Upload Type', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('search narrows the visible rows and clearing restores the catalog @scenario:palette-search-narrows-to-matching-rows', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await selectMockChat(page);
    await openPalette(page);

    const rows = paletteRows(page);
    const fullCatalogCount = await settledRowCount(page);
    expect(fullCatalogCount).toBeGreaterThan(3);

    await paletteSearch(page).fill('Run Code');
    await expect(
      palette(page).getByRole('button', { name: 'Run Code', exact: true }),
    ).toBeVisible();
    await expect(
      palette(page).getByRole('button', { name: 'File Search', exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => rows.count()).toBeLessThan(fullCatalogCount);

    await paletteSearch(page).fill('');
    await expect.poll(() => rows.count()).toBe(fullCatalogCount);
    await expect(
      palette(page).getByRole('button', { name: 'File Search', exact: true }),
    ).toBeVisible();
  });

  test('favourited palette row moves to favourites and persists after reload @scenario:favourited-palette-row-moves-to-favourites-and-persists', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await selectMockChat(page);
    const token = await getAccessToken(page);

    /* The shared e2e user may retain state from a prior interrupted run. Remove
       this one known row first, then prove the UI's own write survives reload. */
    await requestJson(page, { path: TOOL_FAVORITE_PATH, token, method: 'DELETE' });

    try {
      await page.reload({ timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await openPalette(page);
      await paletteSearch(page).fill('Run Code');

      const runCode = palette(page).getByRole('button', { name: 'Run Code', exact: true });
      await expect(runCode).toBeVisible();
      await page.keyboard.press('Control+d');

      await expect(
        palette(page).getByRole('button', { name: 'Remove from favorites', exact: true }),
      ).toBeVisible();
      await expect(
        palette(page).getByRole('button', { name: 'Run Code, Favorites', exact: true }),
      ).toBeVisible();
      await paletteSearch(page).fill('');
      await expect(
        palette(page).getByRole('columnheader', { name: FAVORITE_SECTION, exact: true }),
      ).toBeVisible();
      await expect(
        palette(page).getByRole('button', { name: 'Run Code, Favorites', exact: true }),
      ).toBeVisible();

      await page.reload({ timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await openPalette(page);
      await expect(
        palette(page).getByRole('columnheader', { name: FAVORITE_SECTION, exact: true }),
      ).toBeVisible();
      await expect(
        palette(page).getByRole('button', { name: 'Run Code, Favorites', exact: true }),
      ).toBeVisible();
    } finally {
      await requestJson(page, { path: TOOL_FAVORITE_PATH, token, method: 'DELETE' });
    }
  });

  test('open palette has no detectable accessibility violations @scenario:open-palette-has-no-accessibility-violations', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await selectMockChat(page);
    await openPalette(page);
    await settledRowCount(page);

    const results = await new AxeBuilder({ page })
      .include('[role="dialog"][aria-label="Attach and tools"]')
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('palette is operable from the keyboard alone @scenario:palette-is-operable-from-the-keyboard-alone', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await selectMockChat(page);

    const messageInput = page.getByRole('textbox', { name: 'Message input' });
    await messageInput.focus();
    await expect(messageInput).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(paletteButton(page)).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(palette(page)).toBeVisible();
    await expect(paletteSearch(page)).toBeFocused();
    // Search for the code capability: this lab exposes Run Code (the passing
    // catalog scenarios use the same row), while "search" initially selected
    // Web Search and opened its provider configuration dialog.
    await page.keyboard.type('code');
    const runCode = palette(page).getByRole('button', { name: 'Run Code', exact: true });
    await expect(runCode).toBeVisible();
    const initialActive = await paletteSearch(page).getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    const movedActive = await paletteSearch(page).getAttribute('aria-activedescendant');
    expect(movedActive).not.toBe(initialActive);
    await page.keyboard.press('Enter');

    await expect(runCode).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByTestId('composer-active-builtin').filter({ hasText: 'Run Code' }),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    /* The close was a key press, so focus returns to the message field on every
     * project, a touch-primary one included: only a touch or pen close leaves
     * it alone, to keep the on-screen keyboard from rising again. */
    await expect(messageInput).toBeFocused();
  });

  test('picking rows with the mouse keeps a toggle open and hands focus back to the message field @scenario:palette-mouse-pick-returns-focus-to-the-composer', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await selectMockChat(page);
    const messageInput = page.getByRole('textbox', { name: 'Message input' });

    /* A tool row is a toggle: the press leaves the palette open, and the row has taken focus by
     * then, so the close that follows is what has to give it back to the field. */
    await openPalette(page);
    const memory = palette(page).getByRole('button', { name: 'Memory', exact: true });
    await expect(memory).toBeVisible();
    await memory.click();
    await expect(memory).toHaveAttribute('aria-pressed', 'true');
    await expect(palette(page)).toBeVisible();
    await expect(
      page.getByTestId('composer-active-builtin').filter({ hasText: 'Memory' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    await expect(messageInput).toBeFocused();

    /* An upload destination is terminal: the pick itself closes the palette. */
    await openPalette(page);
    const upload = palette(page).getByRole('button', {
      name: /^(From Local Computer|Upload to Provider)$/,
    });
    await expect(upload).toBeVisible();
    const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), upload.click()]);
    await fileChooser.setFiles([]);
    await expect(palette(page)).toBeHidden();
    await expect(messageInput).toBeFocused();
  });
});

test.describe('composer palette on touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('browses without a keyboard and fits above it when searching', async ({ page }) => {
    await selectMockChat(page);
    const message = page.getByRole('textbox', { name: 'Message input' });
    // Open while already typing, so we also check that the message field gives up focus.
    await message.focus();
    await paletteButton(page).tap();
    await expect(palette(page)).toBeVisible();
    const search = paletteSearch(page);
    await expect(search).not.toBeFocused();
    await expect(message).not.toBeFocused();

    await search.tap();
    await expect(search).toBeFocused();
    // Playwright has no OS keyboard. Shrink and pan just the visual viewport, not the page.
    const { top, bottom } = await page.evaluate(() => {
      const viewport = window.visualViewport!;
      const height = 280;
      const offset = 40;
      Object.defineProperties(viewport, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offset },
        pageTop: { configurable: true, value: scrollY + offset },
      });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
      return { top: offset, bottom: offset + height };
    });
    const panel = palette(page);
    const grid = panel.getByRole('grid');
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box != null && box.y >= top && box.y + box.height <= bottom;
      })
      .toBe(true);
    await expect
      .poll(() => grid.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight > 0))
      .toBe(true);
    // Virtualization must use the smaller grid height, or scrolling stops before the last rows.
    await grid.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() =>
        grid.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return (
            box.bottom <= window.visualViewport!.offsetTop + window.visualViewport!.height &&
            el.scrollHeight - el.scrollTop - el.clientHeight <= 1
          );
        }),
      )
      .toBe(true);

    await search.fill('Run Code');
    await expect(panel.getByRole('button', { name: /^Run Code\b/ })).toBeInViewport();
    await expect(search).toBeFocused();
    await panel.getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(panel).toBeHidden();
    await expect(message).not.toBeFocused();
  });
});
