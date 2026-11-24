import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint } from '../helpers';

/**
 * `interface.defaultPinnedTools: ['mcp']` pins an MCP Servers chip to the
 * composer bar that opens the full server list, the one the palette otherwise
 * keeps behind its own "Show all" after the first five servers.
 */

const CHIP_TEST_ID = 'composer-mcp-servers';
const OPEN_NAME = 'Show all MCP Servers';
const DIALOG_NAME = 'MCP Servers';
/** `librechat.e2e.yaml` gives this server a `title` that differs from its key. */
const SERVER_TITLE = 'E2E Memory';

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

async function openMockChat(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

/** Opens the palette until its MCP section is listed, so the server catalog has
 *  loaded and an absent chip is absent for its config rather than not yet drawn. */
async function waitForServers(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
  await expect(palette.getByRole('columnheader', { name: DIALOG_NAME, exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
}

test.describe('MCP Servers chip', () => {
  test('a pinned chip opens every MCP server in one step @scenario:mcp-servers-chip-opens-full-list', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await withDefaultPinnedTools(page, ['mcp']);
    await openMockChat(page);

    const chip = page.getByTestId(CHIP_TEST_ID);
    await expect(chip).toBeVisible({ timeout: 20000 });
    await expect(chip).toContainText(DIALOG_NAME);

    const open = chip.getByRole('button', { name: OPEN_NAME, exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: DIALOG_NAME, exact: true });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: new RegExp(`^${SERVER_TITLE}`) }),
    ).toBeVisible();
    await expect(dialog.getByRole('searchbox')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
  });

  test('unpinning the chip keeps it off after a reload @scenario:mcp-servers-chip-unpin-persists', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await withDefaultPinnedTools(page, ['mcp']);
    await openMockChat(page);

    const chip = page.getByTestId(CHIP_TEST_ID);
    await expect(chip).toBeVisible({ timeout: 20000 });
    await chip.getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(chip).toHaveCount(0);

    await openMockChat(page);
    await waitForServers(page);
    await expect(chip).toHaveCount(0);
  });

  test('a seeded chip stays pinned after the config drops it @scenario:mcp-servers-chip-seed-persists', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await withDefaultPinnedTools(page, ['mcp']);
    await openMockChat(page);

    const chip = page.getByTestId(CHIP_TEST_ID);
    await expect(chip).toBeVisible({ timeout: 20000 });

    /* `defaultPinnedTools` only seeds the pin; the stored choice is the user's. */
    await page.unroute('**/api/config');
    await withDefaultPinnedTools(page, ['artifacts']);
    await openMockChat(page);
    await expect(chip).toBeVisible({ timeout: 20000 });
  });

  test('without an MCP pin in the config the bar has no MCP Servers chip @scenario:mcp-servers-chip-absent-by-default', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await withDefaultPinnedTools(page, undefined);
    await openMockChat(page);

    await waitForServers(page);
    await expect(page.getByTestId(CHIP_TEST_ID)).toHaveCount(0);
  });
});
