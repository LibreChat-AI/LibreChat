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

/** Opens the palette until its MCP section is listed: the server list arrives after the dialog. */
async function openPaletteWithServers(page: Page) {
  await openPalette(page);
  await expect(
    palette(page).getByRole('columnheader', { name: MCP_SECTION, exact: true }),
  ).toBeVisible({ timeout: 20000 });
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
    test.setTimeout(60000);
    await withDefaultPinnedTools(page, ['execute_code']);
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
    test.setTimeout(60000);
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
    await page.keyboard.type('File Search');

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

    await openPaletteWithServers(page);
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
      await openPaletteWithServers(page);
      /* The section lists its first few servers; each star moves one up into Favorites and
         lets the next one in, until none is left in the section itself. */
      const unstarred = palette(page)
        .locator('[data-row-key^="mcp:"]')
        .filter({ has: page.getByRole('button', { name: 'Add to favorites', exact: true }) });
      let starred = 0;
      while ((await unstarred.count()) > 0) {
        const next = unstarred.first();
        const key = await next.getAttribute('data-row-key');
        expect(key).not.toBeNull();
        await next.hover();
        await next.getByRole('button', { name: 'Add to favorites', exact: true }).click();
        await expect(
          palette(page)
            .locator(`[data-row-key="${key}"]`)
            .getByRole('button', { name: 'Remove from favorites', exact: true }),
        ).toBeAttached();
        starred += 1;
        expect(starred).toBeLessThan(50);
      }
      expect(starred).toBeGreaterThan(0);

      await expect(
        palette(page).getByRole('columnheader', { name: MCP_SECTION, exact: true }),
      ).toBeVisible();
      const pin = palette(page).getByRole('button', { name: MCP_PIN, exact: true });
      await pin.click();
      await expect(pin).toHaveAttribute('aria-pressed', 'true');
      await closePalette(page);
      await expect(page.getByTestId(MCP_CHIP_TEST_ID)).toBeVisible();
    } finally {
      await removeServerFavorites(page, token);
    }
  });
});
