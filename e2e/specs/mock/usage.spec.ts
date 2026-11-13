import AxeBuilder from '@axe-core/playwright';
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

/** Conversation accounting is a remembered disclosure below the visible context legend. */
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
  test('tracks usage from live SSE events and survives reload @scenario:context-live-usage', async ({
    page,
  }) => {
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
    await expect(popover.getByTestId('token-usage-last-turn')).toHaveCount(0);
    const usageSection = popover.getByTestId('token-usage-totals');
    await expect(usageSection).toBeVisible({ timeout: 10000 });
    await expect(usageSection.getByText('Input (uncached)', { exact: true })).toBeVisible();
    await expect(usageSection.getByText('Output', { exact: true })).toBeVisible();

    /** Cost row: interface.contextCost is enabled in the harness yaml, the
     *  token-config endpoint prices mock models at the default rate, and the
     *  fake model emits usage, so a $ value must render. A single (unbranched)
     *  conversation shows only the branch cost, no all-branches total line. */
    const costSection = popover.getByTestId('context-breakdown-toggle').getByTestId('usage-cost');
    await expect(costSection).toBeVisible();
    await expect(costSection.getByText(/\$\d|<\$0\.01/).first()).toBeVisible();
    await expect(popover.getByTestId('token-usage-all-branches')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByTestId('message-usage-button').last().click();
    const turn = page.getByTestId('message-turn-usage');
    await expect(turn.getByRole('heading', { name: 'Turn usage' })).toBeVisible();
    await expect(turn.getByText('Input (uncached)')).toBeVisible();
    await page.keyboard.press('Escape');

    /** Persistence (Parts A + B): after reload the breakdown rehydrates from
     *  the response message's metadata.contextUsage + metadata.usage, the
     *  granular rows AND the branch cost survive without generating a turn. */
    await page.reload({ timeout: 15000 });
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expectGaugeAboveZero(page);
    const reloaded = await openBreakdown(page);
    await expect(reloaded.getByTestId('context-breakdown')).toBeVisible({ timeout: 10000 });
    await expect(reloaded.getByTestId('token-usage-last-turn')).toHaveCount(0);
    const reloadedCost = reloaded.getByTestId('context-breakdown-toggle').getByTestId('usage-cost');
    await expect(reloadedCost).toBeVisible();
    await expect(reloadedCost.getByText(/\$\d|<\$0\.01/).first()).toBeVisible();
  });

  test('renders the granular breakdown from the live context snapshot', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await sendAndAwaitReply(page, 'hello');

    /** The agents pipeline emits on_context_usage on each model call, so the
     *  breakdown, not the estimate fallback, drives the popover. */
    await expectGranular(page);
  });

  test('shows branch cost with all-response usage in conversation info @scenario:conversation-info-branched-usage', async ({
    page,
  }, testInfo) => {
    test.setTimeout(150000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page.getByTestId('conversation-info-menu-item')).toHaveCount(0);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await sendAndAwaitReply(page, 'hello');

    /** Single branch: branch cost == total, so no all-branches line renders. */
    let popover = await openBreakdown(page);
    await expect(
      popover.getByTestId('context-breakdown-toggle').getByTestId('usage-cost'),
    ).toBeVisible();
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
    await expect(
      popover.getByTestId('context-breakdown-toggle').getByTestId('usage-cost'),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    /** After reload both branches rehydrate from persisted metadata.usage, so
     *  the context card keeps the branch cost and conversation info contains
     *  the combined cost of both branches. */
    await page.reload({ timeout: 15000 });
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    const reloaded = await openBreakdown(page);
    const costSection = reloaded.getByTestId('context-breakdown-toggle').getByTestId('usage-cost');
    await expect(costSection).toBeVisible();
    await expect(costSection).toContainText('Cost');
    await expect(reloaded.getByTestId('token-usage-all-branches')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('#export-menu-button:visible, #header-menu-button:visible').click();
    await page.getByTestId('conversation-info-menu-item').click();
    const info = page.getByRole('dialog', { name: 'Conversation info' });
    await expect(
      info.getByTestId('conversation-total-usage').getByTestId('usage-cost'),
    ).toBeVisible();
    const conversationId = new URL(page.url()).pathname.split('/').pop()!;
    await expect(info.getByText(conversationId, { exact: true })).toBeVisible();
    await expect(info.getByRole('button', { name: 'Copy conversation ID' })).toBeVisible();
    await expect(
      info.getByText('Assistant responses', { exact: true }).locator('..'),
    ).toContainText('2');
    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="conversation-info-details"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await testInfo.attach('conversation-info', {
      body: await info.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(info).toBeHidden();
    await expect(page.getByTestId('conversation-info-menu-item')).toBeFocused();
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
    const costSection = popover.getByTestId('context-breakdown-toggle').getByTestId('usage-cost');
    await expect(costSection).toBeVisible();
    /** The branch cost stays available without opening conversation info. */
    await expect(costSection.getByText(/\$\d|<\$0\.01/).first()).toBeVisible();
  });

  test('shows the context legend immediately and remembers expanded conversation accounting @scenario:context-live-disclosure', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await sendAndAwaitReply(page, 'hello');
    await expectGaugeAboveZero(page);

    /** The context composition is visible immediately; accounting is collapsed. */
    await gauge(page).click();
    const popover = page.getByRole('region', { name: 'Context usage' });
    await expect(popover).toBeVisible({ timeout: 10000 });
    const toggle = popover.getByTestId('context-breakdown-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(popover.getByRole('progressbar')).toBeVisible();
    await expect(popover.getByTestId('token-usage-totals')).toBeHidden();
    await expect(popover.getByTestId('context-breakdown')).toBeVisible();

    /** Expanding reveals the detail, and the usage section is labelled so its
     *  numbers are not read as part of the context composition. */
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const totals = popover.getByTestId('token-usage-totals');
    await expect(totals).toBeVisible({ timeout: 10000 });
    await expect(totals).toHaveAccessibleName('Token totals');
    await page.keyboard.press('Escape');

    /** The choice is a stored preference, so a reload reopens expanded with no
     *  second click, the part a component test cannot reach. */
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

  test('reflows condensed sections inside the viewport with keyboard-accessible details @scenario:context-responsive-details', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendAndAwaitReply(page, 'hello');
    const popover = await openBreakdown(page);
    await expect(popover).toHaveCSS('container-type', 'inline-size');
    const dialog = page.getByRole('dialog', { name: 'Context usage' });
    const details = popover.getByTestId('context-breakdown');
    const totals = popover.getByTestId('token-usage-totals');
    const disclosure = popover.getByTestId('context-breakdown-toggle');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(totals.getByText('Cache read', { exact: true })).toBeVisible();

    for (const viewport of [
      { width: 1280, height: 900, columns: 2 },
      { width: 768, height: 800, columns: 2 },
      { width: 375, height: 812, columns: 2 },
      { width: 320, height: 568, columns: 2 },
      { width: 1280, height: 450, columns: 2 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect
        .poll(() =>
          details.evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
          ),
        )
        .toBe(viewport.columns);
      await expect
        .poll(async () => {
          const box = await dialog.boundingBox();
          return (
            box != null &&
            box.x >= 7 &&
            box.y >= 7 &&
            box.x + box.width <= viewport.width - 7 &&
            box.y + box.height <= viewport.height - 7
          );
        })
        .toBe(true);
      await expect
        .poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog).toHaveCSS('transition-duration', '0.36s, 0.36s');
    await disclosure.focus();
    await page.keyboard.press('Space');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(totals).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(totals.getByText('Cache write', { exact: true })).toBeVisible();

    await details.getByText('Messages', { exact: true }).hover();
    await expect(details.getByText('Tool calls', { exact: true }).locator('..')).toHaveCSS(
      'opacity',
      '0.7',
    );
    const accessibility = await new AxeBuilder({ page })
      .include('[data-testid="token-usage-card"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await disclosure.hover();
    await testInfo.attach('context-panel-desktop', {
      body: await dialog.screenshot(),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect
      .poll(() =>
        details.evaluate(
          (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
        ),
      )
      .toBe(2);
    await testInfo.attach('context-panel-mobile', {
      body: await dialog.screenshot(),
      contentType: 'image/png',
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gauge(page).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('transition-duration', '0s');
  });

  test('hides on a new chat, then reveals the breakdown on hover and pins it on click @scenario:context-hover-and-pin', async ({
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
