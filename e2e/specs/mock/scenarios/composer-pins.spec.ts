import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
  selectMockEndpoint,
} from '../helpers';

/**
 * A composer chip's X unpins it, and the palette is the way back: every built-in tool row carries
 * a pin toggle, and the MCP header carries one for the MCP Servers chip. Both write the pin the
 * X clears, so `interface.defaultPinnedTools` stays a seed for users who never chose.
 */

const PALETTE_NAME = 'Attach and tools';
const SEARCH_NAME = 'Search tools, skills and servers';
const MCP_SECTION = 'MCP Servers';
const MCP_PIN = 'Pin MCP Servers';
const MCP_CHIP_TEST_ID = 'composer-mcp-servers';
const FAVORITES_PATH = '/api/user/settings/favorites/tools';
const SERVERS_PATH = '/api/mcp/servers';
/** Where Run Code's pin is stored (`LocalStorageKeys.LAST_CODE_TOGGLE_` plus `pinned`). */
const CODE_PIN_KEY = 'LAST_CODE_TOGGLE_pinned';

interface Favorite {
  itemType: string;
  itemId: string;
}

const palette = (page: Page) => page.getByRole('dialog', { name: PALETTE_NAME, exact: true });
const paletteSearch = (page: Page) =>
  palette(page).getByRole('combobox', { name: SEARCH_NAME, exact: true });
const toolChip = (page: Page, label: string) =>
  page.getByTestId('composer-active-builtin').filter({ hasText: label });
const favoritePath = (server: string) => `${FAVORITES_PATH}/mcp/${encodeURIComponent(server)}`;

/** Serve the startup config with the given pins, without changing the shared
 *  harness config every other spec reads. */
async function withDefaultPinnedTools(page: Page, defaultPinnedTools: string[] | undefined) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, interface: { ...config.interface, defaultPinnedTools } },
    });
  });
}

/** Swaps the served pins for the next load. */
async function reseed(page: Page, defaultPinnedTools: string[] | undefined) {
  await page.unroute('**/api/config');
  await withDefaultPinnedTools(page, defaultPinnedTools);
}

async function openMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

async function openPalette(page: Page) {
  await page.getByRole('button', { name: PALETTE_NAME, exact: true }).click();
  await expect(palette(page)).toBeVisible();
  await expect(paletteSearch(page)).toBeVisible();
}

async function closePalette(page: Page) {
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
}

/** Waits until the row count holds still. While the rows are still changing, the palette keeps
 *  handing focus back to its search field, which would take it from a row action a Tab had
 *  just reached. */
async function settleRows(page: Page) {
  const rows = palette(page).locator('[data-row-key]');
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
}

/** Waits for the MCP section, the catalog's last wave. The list is windowed and the section
 *  sits at its end, so the list is scrolled there the way a reader would. */
async function settleCatalog(page: Page) {
  const header = palette(page).getByRole('columnheader', { name: MCP_SECTION, exact: true });
  await expect(async () => {
    await palette(page)
      .getByRole('grid')
      .evaluate((grid) => {
        grid.scrollTop = grid.scrollHeight;
      });
    await expect(header).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await settleRows(page);
}

async function removeServerFavorites(page: Page, token: string) {
  const favorites = await requestJson<Favorite[]>(page, { path: FAVORITES_PATH, token });
  for (const favorite of favorites) {
    if (favorite.itemType === 'mcp') {
      await requestJson(page, { path: favoritePath(favorite.itemId), token, method: 'DELETE' });
    }
  }
}

test.describe('composer pins', () => {
  test('a tool chip unpinned by its X comes back from the palette pin @scenario:palette-pin-restores-tool-chip', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await withDefaultPinnedTools(page, ['execute_code']);
    await openMockChat(page);
    /* The harness's saved sign-in carries the pin value the app writes on its first load, and
       any stored value is a choice the seed leaves alone. Without it this is a first visit. */
    await page.evaluate((key) => localStorage.removeItem(key), CODE_PIN_KEY);
    await openMockChat(page);

    const chip = toolChip(page, 'Run Code');
    await expect(chip).toBeVisible({ timeout: 20000 });
    await chip.getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(chip).toHaveCount(0);

    await openPalette(page);
    await paletteSearch(page).fill('Run Code');
    const row = palette(page).getByRole('button', { name: 'Run Code', exact: true });
    const pin = palette(page).getByRole('button', { name: 'Pin Run Code', exact: true });
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await row.hover();
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    /* A pin is a quick control, not a selection: the tool stays off. */
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    await closePalette(page);

    await expect(chip).toBeVisible();
    await expect(chip.getByRole('button', { name: 'Select Run Code', exact: true })).toBeVisible();

    /* The stored pin is the user's now: a config that no longer seeds it keeps the chip. */
    await reseed(page, undefined);
    await openMockChat(page);
    await expect(chip).toBeVisible({ timeout: 20000 });
  });

  test('the palette pin adds and removes a tool chip from the keyboard alone @scenario:palette-pin-toggles-from-keyboard', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await withDefaultPinnedTools(page, undefined);
    await openMockChat(page);

    const chip = toolChip(page, 'File Search');
    await expect(chip).toHaveCount(0);

    const messageInput = page.getByRole('textbox', { name: 'Message input' });
    await messageInput.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: PALETTE_NAME, exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(paletteSearch(page)).toBeFocused();
    await settleCatalog(page);
    await expect(paletteSearch(page)).toBeFocused();
    await page.keyboard.type('File Search');
    await expect(
      palette(page).getByRole('button', { name: 'File Search', exact: true }),
    ).toBeVisible();
    await settleRows(page);

    /* The row's own actions follow the search field in the tab order, the pin first. */
    const pin = palette(page).getByRole('button', { name: 'Pin File Search', exact: true });
    await page.keyboard.press('Tab');
    await expect(pin).toBeFocused();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Space');
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toBeVisible();
    await expect(chip.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();

    await page.keyboard.press('Space');
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await expect(chip).toHaveCount(0);

    await closePalette(page);
    await expect(messageInput).toBeFocused();
  });

  test('the MCP Servers chip unpinned by its X comes back from the MCP header pin @scenario:palette-pin-restores-mcp-chip', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await withDefaultPinnedTools(page, ['mcp']);
    await openMockChat(page);

    const chip = page.getByTestId(MCP_CHIP_TEST_ID);
    await expect(chip).toBeVisible({ timeout: 20000 });
    await chip.getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(chip).toHaveCount(0);

    await openPalette(page);
    await settleCatalog(page);
    const pin = palette(page).getByRole('button', { name: MCP_PIN, exact: true });
    await expect(pin).toBeVisible();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    await pin.click();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await closePalette(page);
    await expect(chip).toBeVisible();

    await reseed(page, undefined);
    await openMockChat(page);
    await expect(chip).toBeVisible({ timeout: 20000 });
  });

  test('the MCP header keeps its pin while every server is a favorite @scenario:palette-pin-kept-with-every-server-starred', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await withDefaultPinnedTools(page, undefined);
    await openMockChat(page);
    const token = await getAccessToken(page);
    /* The worker's user may keep favorites from an interrupted run. */
    await removeServerFavorites(page, token);

    try {
      /* Starred through the same API the star writes: the star is not what is under test, and
         the list would scroll a starred row out of reach as it moved up. */
      const servers = await requestJson<Record<string, unknown>>(page, {
        path: SERVERS_PATH,
        token,
      });
      const names = Object.keys(servers);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        await requestJson(page, { path: favoritePath(name), token, method: 'PUT' });
      }
      await openMockChat(page);

      await openPalette(page);
      await expect(
        palette(page).getByRole('columnheader', { name: 'Favorites', exact: true }),
      ).toBeVisible({ timeout: 20000 });
      await settleCatalog(page);
      /* No server is left in the section itself; the header stays for its pin. */
      await expect(
        palette(page)
          .locator('[data-row-key^="mcp:"]')
          .filter({ has: page.getByRole('button', { name: 'Add to favorites', exact: true }) }),
      ).toHaveCount(0);
      const pin = palette(page).getByRole('button', { name: MCP_PIN, exact: true });
      await expect(pin).toHaveAttribute('aria-pressed', 'false');
      await pin.click();
      await expect(pin).toHaveAttribute('aria-pressed', 'true');
      await closePalette(page);
      await expect(page.getByTestId(MCP_CHIP_TEST_ID)).toBeVisible();
    } finally {
      await removeServerFavorites(page, token);
    }
  });
});
