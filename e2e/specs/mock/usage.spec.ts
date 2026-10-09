import { expect, test } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import {
  mockReply,
  sendMessage,
  messagesView,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  isAgentsStream,
  selectMockEndpoint,
} from './helpers';

const gauge = (page: Page) => page.getByTestId('token-usage');
const gaugeMeter = (page: Page) => gauge(page).getByRole('meter');

async function expectGaugeAboveZero(page: Page) {
  await expect(gauge(page)).toBeVisible({ timeout: 20000 });
  await expect(gaugeMeter(page)).toHaveAttribute('aria-valuenow', /[1-9]/, { timeout: 20000 });
}

/** The popover opens showing the gauge alone; the detail sits behind a
 *  disclosure whose state is remembered per user. Idempotent, so it is safe to
 *  call after a reload that restored an already-expanded preference. */
async function expandBreakdown(popover: Locator) {
  const toggle = popover.getByTestId('context-breakdown-toggle');
  await expect(toggle).toBeVisible({ timeout: 10000 });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** Opens the gauge breakdown popover (a click, which also pins it), expands
 *  the detail, and returns its region. */
async function openBreakdown(page: Page) {
  await expectGaugeAboveZero(page);
  await gauge(page).click();
  const popover = page.getByRole('region', { name: 'Context usage' });
  await expect(popover).toBeVisible({ timeout: 10000 });
  await expandBreakdown(popover);
  return popover;
}

/** Granularity lives only in the live `on_context_usage` snapshot; its rows
 *  render under the `context-breakdown` testid, the coarse message-history
 *  fallback under `context-estimate`. They are mutually exclusive. */
async function expectGranular(page: Page) {
  const popover = await openBreakdown(page);
  await expect(popover.getByTestId('context-breakdown')).toBeVisible({ timeout: 10000 });
  await expect(popover.getByTestId('context-estimate')).toHaveCount(0);
  await expect(popover.getByText('Messages', { exact: true })).toBeVisible();
  await expect(popover.getByText('Free space', { exact: true })).toBeVisible();
}

async function sendAndAwaitReply(page: Page, text: string) {
  const response = await sendMessage(page, text);
  expect(response.ok()).toBeTruthy();
  await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
}

test.describe('context usage gauge', () => {
  test('tracks usage from live SSE events and survives reload', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    // REQUIRED so the message streams without a real key.
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessage(page, 'hello');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    /** Live path: the agents pipeline's context snapshot + usage events fill the gauge */
    await expectGaugeAboveZero(page);

    /** Breakdown popover: context section always; the usage section is
     *  scoped by testid since the pre-snapshot fallback renders its own
     *  Input/Output rows when the lib predates on_context_usage */
    const popover = await openBreakdown(page);
    await expect(popover.getByText('Context window')).toBeVisible();
    const lastTurn = popover.getByTestId('token-usage-last-turn');
    await expect(lastTurn.getByRole('heading', { name: 'Last turn' })).toBeVisible();
    await expect(lastTurn.getByText('Input (uncached)')).toBeVisible();
    const usageSection = popover.getByTestId('token-usage-totals');
    await expect(usageSection).toBeVisible({ timeout: 10000 });
    await expect(usageSection.getByText('Input (uncached)', { exact: true })).toBeVisible();
    await expect(usageSection.getByText('Output', { exact: true })).toBeVisible();

    /** Cost row: interface.contextCost is enabled in the harness yaml, the
     *  token-config endpoint prices mock models at the default rate, and the
     *  fake model emits usage — so a $ value must render. A single (unbranched)
     *  conversation shows only the branch cost, no all-branches total line. */
    const costSection = popover.getByTestId('token-usage-cost');
    await expect(costSection).toBeVisible();
    await expect(costSection.getByText(/\$\d|<\$0\.01/).first()).toBeVisible();
    await expect(costSection.getByText('All branches')).toHaveCount(0);
    await page.keyboard.press('Escape');

    /** Persistence (Parts A + B): after reload the breakdown rehydrates from
     *  the response message's metadata.contextUsage + metadata.usage — the
     *  granular rows AND the branch cost survive without generating a turn. */
    await page.reload({ timeout: 15000 });
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expectGaugeAboveZero(page);
    const reloaded = await openBreakdown(page);
    await expect(reloaded.getByTestId('context-breakdown')).toBeVisible({ timeout: 10000 });
    await expect(reloaded.getByTestId('token-usage-last-turn')).toContainText('Input (uncached)');
    const reloadedCost = reloaded.getByTestId('token-usage-cost');
    await expect(reloadedCost).toBeVisible();
    await expect(reloadedCost.getByText(/\$\d|<\$0\.01/).first()).toBeVisible();
  });

  test('renders the granular breakdown from the live context snapshot', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await sendAndAwaitReply(page, 'hello');

    /** The agents pipeline emits on_context_usage on each model call, so the
     *  breakdown — not the estimate fallback — drives the popover. */
    await expectGranular(page);
  });

  test('shows branch cost with an all-branches total after regenerating', async ({ page }) => {
    test.setTimeout(150000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await sendAndAwaitReply(page, 'hello');

    /** Single branch: branch cost == total, so no all-branches line renders. */
    let popover = await openBreakdown(page);
    await expect(popover.getByTestId('token-usage-cost')).toBeVisible();
    await expect(popover.getByText('All branches')).toHaveCount(0);
    await page.keyboard.press('Escape');

    /** Regenerate to create a sibling branch (B). */
    const assistantMessage = messagesView(page).locator('.message-render').nth(1);
    await assistantMessage.hover();
    const regenerateButton = assistantMessage
      .getByRole('button', { name: 'Regenerate', exact: true })
      .last();
    await expect(regenerateButton).toBeVisible();
    const [regen] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenerateButton.click(),
    ]);
    expect(regen.ok()).toBeTruthy();
    await expect(page.getByText('2 / 2')).toBeVisible({ timeout: 20000 });

    /** Branch cost is shown live for the regenerated branch. */
    popover = await openBreakdown(page);
    await expect(popover.getByTestId('token-usage-cost')).toBeVisible();
    await page.keyboard.press('Escape');

    /** After reload both branches rehydrate from persisted metadata.usage, so
     *  the cost is branch-scoped and a muted all-branches total appears (it
     *  exceeds the single viewed branch). */
    await page.reload({ timeout: 15000 });
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    const reloaded = await openBreakdown(page);
    const costSection = reloaded.getByTestId('token-usage-cost');
    await expect(costSection).toBeVisible();
    await expect(costSection.getByText('Cost (this branch)')).toBeVisible();
    await expect(costSection.getByText('All branches')).toBeVisible();
  });

  test('preserves the granular breakdown after switching branches', async ({ page }) => {
    test.setTimeout(150000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await sendAndAwaitReply(page, 'hello');

    /** Branch A: the just-generated branch shows its live snapshot. */
    await expectGranular(page);
    await page.keyboard.press('Escape');

    /** Regenerate to create a sibling branch (B), which overwrites the single
     *  live snapshot and anchors it to B's response (proven selectors mirror
     *  chat.spec.ts's branch test). */
    const assistantMessage = messagesView(page).locator('.message-render').nth(1);
    await assistantMessage.hover();
    const regenerateButton = assistantMessage
      .getByRole('button', { name: 'Regenerate', exact: true })
      .last();
    await expect(regenerateButton).toBeVisible();
    const [regen] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      regenerateButton.click(),
    ]);
    expect(regen.ok()).toBeTruthy();
    await expect(page.getByText('2 / 2')).toBeVisible({ timeout: 20000 });

    /** Switch back to branch A. Its live snapshot was overwritten by B, so the
     *  rows can only survive via the per-anchor snapshot history map. */
    await page.getByRole('button', { name: 'Previous sibling message' }).click();
    await expect(page.getByText('1 / 2')).toBeVisible({ timeout: 10000 });

    await expectGranular(page);

    /** Branch cost must also survive the switch (live, no reload): branch A's
     *  flushed usage is restored from the sticky usage history even though its
     *  cache message lacks metadata.usage and B's regenerate dropped it. */
    const popover = page.getByRole('region', { name: 'Context usage' });
    const costSection = popover.getByTestId('token-usage-cost');
    await expect(costSection).toBeVisible();
    /** Branch A also has siblings, so both a branch-cost row and an all-branches
     *  total render — assert at least one cost value is present. */
    await expect(costSection.getByText(/\$\d|<\$0\.01/).first()).toBeVisible();
  });

  test('opens to the gauge alone and remembers an expanded breakdown', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await sendAndAwaitReply(page, 'hello');
    await expectGaugeAboveZero(page);

    /** Default view is the gauge: the meter and its readout, nothing else. */
    await gauge(page).click();
    const popover = page.getByRole('region', { name: 'Context usage' });
    await expect(popover).toBeVisible({ timeout: 10000 });
    const toggle = popover.getByTestId('context-breakdown-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(popover.getByRole('progressbar')).toBeVisible();
    await expect(popover.getByTestId('token-usage-totals')).toHaveCount(0);
    await expect(popover.getByTestId('context-breakdown')).toHaveCount(0);

    /** Expanding reveals the detail, and the usage section is labelled so its
     *  numbers are not read as part of the context composition. */
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const totals = popover.getByTestId('token-usage-totals');
    await expect(totals).toBeVisible({ timeout: 10000 });
    await expect(totals.getByRole('heading', { name: 'Totals' })).toBeVisible();
    await page.keyboard.press('Escape');

    /** The choice is a stored preference, so a reload reopens expanded with no
     *  second click — the part a component test cannot reach. */
    await page.reload({ timeout: 15000 });
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expectGaugeAboveZero(page);
    await gauge(page).click();
    await expect(popover).toBeVisible({ timeout: 10000 });
    await expect(popover.getByTestId('context-breakdown-toggle')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(popover.getByTestId('token-usage-totals')).toBeVisible({ timeout: 10000 });
  });

  test('hides on a new chat, then reveals the breakdown on hover and pins it on click', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    /** A fresh, message-less chat shows no gauge (it is not mounted). */
    await expect(gauge(page)).toHaveCount(0);

    await sendAndAwaitReply(page, 'hello');
    await expectGaugeAboveZero(page);

    /** Hover opens the full breakdown after the intent delay; the compact
     *  tooltip is gone, and the popover carries no tooltip role. */
    await gauge(page).hover();
    const popover = page.getByRole('region', { name: 'Context usage' });
    await expect(popover).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    /** Moving the pointer away closes it: hover is the only thing holding it. */
    await messagesView(page).hover({ position: { x: 5, y: 5 } });
    await expect(popover).toBeHidden({ timeout: 10000 });

    /** Click pins the breakdown: the pointer can leave without it closing. */
    await gauge(page).hover();
    await expect(popover).toBeVisible({ timeout: 10000 });
    await gauge(page).click();
    await messagesView(page).hover({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(500);
    await expect(popover).toBeVisible();
    await gauge(page).click();
    await expect(popover).toBeHidden({ timeout: 10000 });

    /** A click-opened popover is pinned too; Escape (focus-away) closes it. */
    await gauge(page).click();
    await expect(popover).toBeVisible({ timeout: 10000 });
    await expect(popover.getByText('Context window')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden({ timeout: 10000 });

    /** Reopen, then dismiss by clicking outside (blur). */
    await gauge(page).click();
    await expect(popover).toBeVisible({ timeout: 10000 });
    await messagesView(page).click({ position: { x: 5, y: 5 } });
    await expect(popover).toBeHidden({ timeout: 10000 });
  });
});
