import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { sendMessage, selectMockEndpoint } from '../mock/helpers';

/**
 * LOCAL-ONLY real-provider verification: drives multiple turns against real
 * Anthropic and asserts the context gauge tracks genuine provider usage.
 * Runs only via e2e/playwright.config.real.ts (requires ANTHROPIC_API_KEY).
 */

const REAL_MODEL = process.env.E2E_REAL_ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

const gauge = (page: Page) => page.getByTestId('token-usage');
const gaugeMeter = (page: Page) => gauge(page).getByRole('meter');
const popover = (page: Page) => page.getByRole('region', { name: 'Context usage' });

async function gaugeValue(page: Page): Promise<number> {
  const raw = await gaugeMeter(page).getAttribute('aria-valuenow');
  const value = Number(raw);
  expect(Number.isFinite(value)).toBe(true);
  return value;
}

/** Parses formatTokens output ("950", "1.2K", "2M") back to a number. */
function parseTokens(text: string): number {
  const match = text.trim().match(/^([\d.]+)([KM])?/i);
  if (!match) {
    return NaN;
  }
  const suffix = match[2]?.toUpperCase();
  let scale = 1;
  if (suffix === 'M') {
    scale = 1e6;
  } else if (suffix === 'K') {
    scale = 1e3;
  }
  return parseFloat(match[1]) * scale;
}

async function readUsageTotals(page: Page): Promise<{ input: number; output: number }> {
  /** Click, not hover: hover only surfaces the compact snapshot tooltip. The
   *  popover then opens to the gauge alone, with the totals behind a remembered
   *  disclosure — idempotent, since the preference survives the previous turn. */
  await gauge(page).click();
  await expect(popover(page)).toBeVisible({ timeout: 15000 });
  const toggle = popover(page).getByTestId('context-breakdown-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  const section = popover(page).getByTestId('token-usage-totals');
  await expect(section).toBeVisible({ timeout: 15000 });
  const rows = section.locator('div');
  const input = parseTokens(
    (await rows.filter({ hasText: 'Input' }).first().locator('span').last().innerText()) ?? '',
  );
  const output = parseTokens(
    (await rows.filter({ hasText: 'Output' }).first().locator('span').last().innerText()) ?? '',
  );
  await page.keyboard.press('Escape');
  return { input, output };
}

async function sendTurn(page: Page, text: string) {
  const response = await sendMessage(page, text);
  expect(response.ok()).toBeTruthy();
  /** Settle: streaming over once the stop button yields back to send */
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
    timeout: 90000,
  });
  await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30000 });
}

test.describe('context usage gauge with a real provider', () => {
  test('grows across turns and reflects real usage', async ({ page }, testInfo: TestInfo) => {
    test.setTimeout(300000);
    await page.goto('/c/new', { timeout: 15000 });

    await selectMockEndpoint(page, { label: 'Anthropic', model: REAL_MODEL } as never);

    /** Turn 1 */
    await sendTurn(page, 'Reply with exactly one word: alpha');
    await expect(gauge(page)).toBeVisible({ timeout: 20000 });
    const v1 = await gaugeValue(page);
    expect(v1).toBeGreaterThan(0);
    const totals1 = await readUsageTotals(page);
    expect(totals1.input).toBeGreaterThan(0);
    expect(totals1.output).toBeGreaterThan(0);
    await gauge(page).hover();
    await expect(popover(page).getByText('Messages')).toBeVisible();
    await expect(popover(page).getByText('Free space')).toBeVisible();
    await expect(popover(page).getByText('Session cost')).toBeVisible();
    await expect(popover(page).getByText(/\$\d|<\$0\.01/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('turn1-popover.png') });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    /** Turn 2: context must include turn 1 — gauge and totals grow */
    await sendTurn(page, 'Reply with exactly one word: beta');
    const v2 = await gaugeValue(page);
    expect(v2).toBeGreaterThan(v1);
    const totals2 = await readUsageTotals(page);
    expect(totals2.input).toBeGreaterThan(totals1.input);
    expect(totals2.output).toBeGreaterThan(totals1.output);

    /** Turn 3 */
    await sendTurn(page, 'Reply with exactly one word: gamma');
    const v3 = await gaugeValue(page);
    expect(v3).toBeGreaterThan(v2);
    await gauge(page).hover();
    await expect(popover(page)).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: testInfo.outputPath('turn3-popover.png') });
    await page.keyboard.press('Escape');

    /** Reload: gauge rebuilds from persisted per-message token counts once
     *  the messages query resolves — retry until the meter leaves zero */
    await page.reload({ timeout: 20000 });
    await expect(gauge(page)).toBeVisible({ timeout: 20000 });
    await expect(gaugeMeter(page)).toHaveAttribute('aria-valuenow', /[1-9]/, { timeout: 20000 });
    const vReload = await gaugeValue(page);
    expect(vReload).toBeGreaterThan(0);
    await gauge(page).hover();
    await expect(popover(page)).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: testInfo.outputPath('reload-popover.png') });

    testInfo.annotations.push({
      type: 'observed',
      description: `v1=${v1} v2=${v2} v3=${v3} reload=${vReload} input1=${totals1.input} input2=${totals2.input}`,
    });
  });
});
