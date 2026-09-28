import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  escapeRegExp,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

const MCP_SERVER_TITLE = 'E2E Memory';
const TOOL_FINAL_TEXT = 'E2E steer tool reply done';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const gauge = (page: Page) => page.getByTestId('token-usage');
const gaugeMeter = (page: Page) => gauge(page).getByRole('meter');

async function expectGaugeAboveZero(page: Page) {
  await expect(gauge(page)).toBeVisible({ timeout: 20000 });
  await expect(gaugeMeter(page)).toHaveAttribute('aria-valuenow', /[1-9]/, { timeout: 20000 });
}

/** Select the ephemeral MCP server whose real remember_fact tool creates the
 * tool boundary and causes the fake model to take its tool-response path. */
async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();
  const serverItem = page.getByRole('menuitemcheckbox', { name: new RegExp(MCP_SERVER_TITLE) });
  await expect(serverItem).toBeVisible();
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: new RegExp(MCP_SERVER_TITLE) })).toBeVisible();
}

/** The popover opens with only the meter visible; its detail is a remembered
 * disclosure, so this helper is deliberately idempotent across reloads. */
async function expandBreakdown(popover: Locator) {
  const toggle = popover.getByTestId('context-breakdown-toggle');
  await expect(toggle).toBeVisible({ timeout: 10000 });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** Opens the click-pinned popover and expands its context detail. Hover is not
 * used because it is unavailable on the touch project. */
async function openBreakdown(page: Page) {
  await expectGaugeAboveZero(page);
  await gauge(page).click();
  const popover = page.getByRole('region', { name: 'Context usage' });
  await expect(popover).toBeVisible({ timeout: 10000 });
  await expandBreakdown(popover);
  return popover;
}

async function runToolTurn(page: Page, prefix: string) {
  const label = uniqueLabel(prefix);
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  // The endpoint must be committed before the ephemeral agent is selected.
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await selectEphemeralMCP(page);
  const response = await sendMessageAndWaitForCompletion(page, `E2E_STEER_TOOL_REPLY:${label}`, {
    timeout: 120000,
  });
  expect(response.ok()).toBeTruthy();
  await expect(
    messagesView(page).getByText(new RegExp(`${TOOL_FINAL_TEXT} ${escapeRegExp(label)}`)),
  ).toBeVisible({ timeout: 30000 });
}

function directPeerRows(breakdown: Locator) {
  return breakdown.locator(':scope > *:not(.pl-6)');
}

function rowValue(row: Locator) {
  return row.locator(':scope > span').last();
}

test.describe('retained tool context split', () => {
  /** Every test here needs a real tool boundary, and the only affordance that
   *  attaches one to an ephemeral conversation is the composer's MCP Servers
   *  picker, which the phone layout does not render (its narrow composer keeps
   *  the tool pickers behind a sidebar that overlays the input). The split
   *  itself is viewport-independent: it is computed by the hook, and the mobile
   *  project still exercises the same rows through the persisted fixtures in
   *  `persisted-context-usage.spec.ts`. */
  test.skip(({ isMobile }) => isMobile === true, 'composer MCP picker is desktop-only');

  test('splits retained tool traffic out of the message total @scenario:tool-calls-split-from-messages', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await runToolTurn(page, 'context-split');

    const popover = await openBreakdown(page);
    const breakdown = popover.getByTestId('context-breakdown');
    await expect(breakdown).toBeVisible({ timeout: 10000 });
    await expect(popover.getByTestId('context-estimate')).toHaveCount(0);

    const peers = directPeerRows(breakdown);
    const toolRow = peers.filter({ hasText: 'Tool calls' });
    const messageRow = peers.filter({ hasText: 'Messages' });
    await expect(toolRow).toHaveCount(1);
    await expect(messageRow).toHaveCount(1);
    // Tool calls and Messages are meter peers, not an indented subset row.
    await expect(toolRow.locator('xpath=ancestor::*[contains(@class, "pl-6")]')).toHaveCount(0);
    await expect(messageRow.locator('xpath=ancestor::*[contains(@class, "pl-6")]')).toHaveCount(0);

    const toolValue = (await rowValue(toolRow).innerText()).split('(')[0].trim();
    const messageValue = (await rowValue(messageRow).innerText()).split('(')[0].trim();
    // The real tool round-trip contributes a non-zero retained share, shown
    // separately from Messages; values are compact-formatted by the UI.
    expect(toolValue).not.toBe('0');
    expect(toolValue).not.toBe(messageValue);
    await expect(toolRow.locator('span.bg-series-2')).toHaveCount(1);
  });

  test('discloses per-tool counts with keyboard controls @scenario:per-tool-counts-keyboard-disclosure', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await runToolTurn(page, 'keyboard-disclosure');

    const popover = await openBreakdown(page);
    const breakdown = popover.getByTestId('context-breakdown');
    const toolRow = directPeerRows(breakdown).filter({ hasText: 'Tool calls' });
    // Selecting the native button directly proves this row is keyboard-operable,
    // rather than merely looking like a clickable div.
    const toolButton = breakdown.locator(':scope > button').filter({ hasText: 'Tool calls' });
    await expect(toolButton).toHaveCount(1);
    await expect(toolButton).toHaveAttribute('aria-expanded', 'false');
    await expect(toolRow).toHaveCount(1);

    await toolButton.focus();
    await expect(toolButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toolButton).toHaveAttribute('aria-expanded', 'true');
    await expect(toolButton).toBeFocused();

    const panelId = await toolButton.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const toolPanel = popover.locator(`[id="${panelId}"]`);
    await expect(toolPanel.getByText('By tool', { exact: true })).toBeVisible();
    const namedToolRow = toolPanel.locator(':scope > *').filter({ hasText: /remember_fact/ });
    await expect(namedToolRow).toHaveCount(1);
    await expect(namedToolRow).toHaveText(/remember_fact[\s\S]*(?:[1-9]\d{0,2}|\d+(?:\.\d+)?K)/);

    await page.keyboard.press('Space');
    await expect(toolButton).toHaveAttribute('aria-expanded', 'false');
    await expect(toolButton).toBeFocused();
    await expect(toolPanel.getByText('By tool', { exact: true })).toHaveCount(0);
  });

  test('keeps visible context peers within the meter @scenario:context-rows-never-exceed-the-meter', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await runToolTurn(page, 'meter-bound');

    const popover = await openBreakdown(page);
    const breakdown = popover.getByTestId('context-breakdown');
    const meter = popover.getByRole('progressbar');
    await expect(breakdown).toBeVisible({ timeout: 10000 });
    const usedPercent = Number(await meter.getAttribute('aria-valuenow'));
    expect(Number.isFinite(usedPercent)).toBeTruthy();
    expect(usedPercent).toBeGreaterThan(0);

    const peers = directPeerRows(breakdown);
    await expect(peers.filter({ hasText: 'Messages' })).toHaveCount(1);
    await expect(peers.filter({ hasText: 'Tool calls' })).toHaveCount(1);

    const toolButton = breakdown.locator(':scope > button').filter({ hasText: 'Tool calls' });
    await toolButton.focus();
    await page.keyboard.press('Enter');
    await expect(toolButton).toHaveAttribute('aria-expanded', 'true');
    // Since compact values can be 1.5K, use the UI's subset relation instead
    // of parsing rounded values: only segment peers may count toward the meter.
    // Per-tool, cached, and instruction rows are always indented subsets.
    await expect(peers.filter({ hasText: /remember_fact/ })).toHaveCount(0);
    await expect(peers.filter({ hasText: 'Agent instructions' })).toHaveCount(0);
    await expect(peers.filter({ hasText: 'Cached' })).toHaveCount(0);
    await expect(peers.filter({ hasText: 'Cache write' })).toHaveCount(0);
  });

  test('rehydrates the tool split after reload @scenario:tool-split-survives-reload', async ({
    page,
  }) => {
    test.setTimeout(180000);
    await runToolTurn(page, 'reload-split');

    const initialPopover = await openBreakdown(page);
    const initialBreakdown = initialPopover.getByTestId('context-breakdown');
    const initialToolRow = directPeerRows(initialBreakdown).filter({ hasText: 'Tool calls' });
    await expect(initialToolRow).toHaveCount(1);
    const initialToolButton = initialBreakdown
      .locator(':scope > button')
      .filter({ hasText: 'Tool calls' });
    await initialToolButton.click();
    const initialPanelId = await initialToolButton.getAttribute('aria-controls');
    expect(initialPanelId).toBeTruthy();
    const initialPanel = initialPopover.locator(`[id="${initialPanelId}"]`);
    const initialNamedTool = initialPanel
      .locator(':scope > *')
      .filter({ hasText: /remember_fact/ });
    await expect(initialNamedTool).toHaveCount(1);
    const initialToolName = (await initialNamedTool.innerText()).trim().split(/\s+/)[0];
    expect(initialToolName).toMatch(/remember_fact/);

    await page.reload({ timeout: 15000 });
    await expectGaugeAboveZero(page);
    await expect(messagesView(page).getByText(/E2E steer tool reply done/)).toBeVisible({
      timeout: 20000,
    });
    const reloadedPopover = await openBreakdown(page);
    const reloadedBreakdown = reloadedPopover.getByTestId('context-breakdown');
    await expect(reloadedBreakdown).toBeVisible({ timeout: 10000 });
    await expect(reloadedPopover.getByTestId('context-estimate')).toHaveCount(0);
    const reloadedToolButton = reloadedBreakdown
      .locator(':scope > button')
      .filter({ hasText: 'Tool calls' });
    await expect(reloadedToolButton).toHaveCount(1);
    await reloadedToolButton.click();
    const reloadedPanelId = await reloadedToolButton.getAttribute('aria-controls');
    expect(reloadedPanelId).toBeTruthy();
    const reloadedPanel = reloadedPopover.locator(`[id="${reloadedPanelId}"]`);
    await expect(reloadedPanel.getByText('By tool', { exact: true })).toBeVisible();
    await expect(reloadedPanel.getByText(initialToolName, { exact: true })).toBeVisible();
    await expect(
      reloadedPanel.locator(':scope > *').filter({ hasText: /remember_fact/ }),
    ).toHaveText(/remember_fact[\s\S]*(?:[1-9]\d{0,2}|\d+(?:\.\d+)?K)/);
  });
});
