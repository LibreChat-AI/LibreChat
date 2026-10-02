import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, selectMockEndpoint, sendMessage } from './helpers';

const PHASE_ENDPOINT = { label: 'Mock Provider F', model: 'mock-model-f' };
const MCP_SERVER_TITLE = 'E2E Memory';
const LABEL_SERVER = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;
const PHASE_LABEL = 'Gathered both facts around a broken echo';
const SHOT_DIR = process.env.E2E_FOLD_SHOTS || '';

const uniqueLabel = () => `fold-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) {
    return;
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

async function setPhaseLabel(request: APIRequestContext) {
  await request.post(`${LABEL_SERVER}/__e2e/reset`);
  const response = await request.post(`${LABEL_SERVER}/__e2e/behavior`, {
    data: { phaseLabel: PHASE_LABEL, labelsByPrompt: {} },
  });
  expect(response.ok()).toBeTruthy();
}

async function selectEphemeralMCP(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools' });
  const serverItem = palette.getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(serverItem).toBeVisible({ timeout: 20_000 });
  await serverItem.click();
  await expect(serverItem).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true })).toBeVisible();
}

function collectPageProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.text().includes('Warning:')) {
      problems.push(`console.${message.type()}: ${message.text().slice(0, 300)}`);
    }
  });
  return problems;
}

test.describe('activity fold', () => {
  test('titles the open fold, rails its rows and reaches the failed call in one click', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const problems = collectPageProblems(page);
    const label = uniqueLabel();
    const finalText = `E2E activity failed reply done ${label}`;
    await setPhaseLabel(request);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PHASE_ENDPOINT);
    await selectEphemeralMCP(page);
    const run = await sendMessage(page, `E2E_ACTIVITY_FAILED_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();

    /** The live span: sample the fold while the slow echo keeps the batch
     *  open, so the streaming header and any pill it grows are on record. */
    const liveHeaders: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.waitForTimeout(600);
      const card = messagesView(page).getByTestId('activity-phase-card').first();
      if (await card.isVisible().catch(() => false)) {
        liveHeaders.push((await card.innerText()).replace(/\s+/g, ' ').trim());
        await shot(page, `live-${index}`);
      }
    }
    /** The header ticks through the run's live lines before the label lands. */
    expect(liveHeaders.some((line) => /Running/.test(line))).toBe(true);

    await expect(messagesView(page).getByText(finalText)).toBeVisible({ timeout: 60000 });
    const header = messagesView(page).getByRole('button', { name: PHASE_LABEL, exact: true });
    await expect(header).toBeVisible({ timeout: 30000 });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await shot(page, 'settled-collapsed');

    const pill = messagesView(page).getByTestId('failed-reveal-pill');
    const peek = messagesView(page).getByTestId('activity-phase-failed-peek');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAccessibleName('Show 1 failed call out of 4 calls');
    await expect(peek).toBeVisible();
    await expect(peek).toContainText('Failed:');
    await expect(peek).toContainText('Show error');

    /** One click from the closed card to the open error panel. */
    await peek.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(peek).toBeHidden();
    const failedRow = messagesView(page)
      .locator('[data-testid="tool-call"]')
      .filter({ hasText: /^Failed:/ });
    await expect(failedRow).toBeVisible();
    await expect(failedRow).toContainText('failed');
    const failedId = await failedRow.getAttribute('data-tool-call-id');
    const panel = messagesView(page).locator(`[data-tool-call-output-id="${failedId}"]`);
    await expect(panel).toContainText(/error/i, { timeout: 5000 });
    /** Focus lands on the failed row's own disclosure button, not a wrapper. */
    expect(
      await page.evaluate(() => {
        const active = document.activeElement;
        return {
          tag: active?.tagName,
          row: active?.closest('[data-testid="tool-call"]')?.getAttribute('data-tool-call-id'),
        };
      }),
    ).toEqual({ tag: 'BUTTON', row: failedId });
    await shot(page, 'revealed');

    /** The open header is the title: primary, semibold, over railed rows. */
    await expect(header).toHaveClass(/font-semibold/);
    await expect(header).toHaveClass(/text-text-primary/);
    const rail = messagesView(page).getByTestId('activity-phase-panel').locator('> div').first();
    await expect(rail).toHaveClass(/pl-6/);
    /** Only the group holding the failure opened; its sibling groups stay
     *  folded under the phase. The slow echo shares that batch. */
    expect(await messagesView(page).locator('[data-testid="tool-call"]').count()).toBe(2);
    await expect(messagesView(page).getByTestId('tool-call-group-panel')).toHaveCount(3);

    /** Closing by the header brings the peek back; the pill then does the
     *  same reveal from the closed state. */
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(peek).toBeVisible();
    await pill.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toContainText(/error/i);
    await shot(page, 'revealed-by-pill');

    /** Each open fold's rail lights up under the pointer, swaps ITS header's
     *  glyph for a collapse knob, and collapses only that fold. */
    const knobs = messagesView(page).getByTestId('fold-rail-knob');
    const phaseRail = messagesView(page)
      .getByTestId('activity-phase-panel')
      .locator('> div > [data-testid="fold-rail"]');
    const groupPanel = messagesView(page)
      .getByTestId('tool-call-group-panel')
      .filter({ has: page.getByTestId('tool-call').filter({ hasText: /^Failed:/ }) });
    const groupRail = groupPanel.locator('> div > [data-testid="fold-rail"]');
    const groupHeader = groupPanel.locator('xpath=preceding-sibling::div[1]').getByRole('button');
    const lineColor = (railLocator: typeof groupRail) =>
      railLocator.locator('span').evaluate((line) => getComputedStyle(line).backgroundColor);
    const restingLine = await lineColor(groupRail);
    await expect(knobs).toHaveCount(0);
    await groupRail.hover();
    await expect(knobs).toHaveCount(1);
    await expect(groupHeader.getByTestId('fold-rail-knob')).toBeVisible();
    await expect.poll(() => lineColor(groupRail)).not.toBe(restingLine);
    await shot(page, 'group-rail-hover');
    await phaseRail.hover();
    await expect(knobs).toHaveCount(1);
    await expect(header.getByTestId('fold-rail-knob')).toBeVisible();
    await shot(page, 'phase-rail-hover');
    await groupRail.click();
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await phaseRail.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(knobs).toHaveCount(0);
    await shot(page, 'rail-collapsed');

    /** Survives a reload from the persisted message. */
    await page.reload();
    const reloaded = messagesView(page).getByRole('button', { name: PHASE_LABEL, exact: true });
    await expect(reloaded).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByTestId('failed-reveal-pill')).toBeVisible();
    await expect(messagesView(page).getByTestId('activity-phase-failed-peek')).toBeVisible();
    await shot(page, 'reloaded-collapsed');
    await messagesView(page).getByTestId('activity-phase-failed-peek').click();
    await expect(
      messagesView(page).locator('[data-tool-call-output-id]').filter({ hasText: /error/i }),
    ).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(400);
    await shot(page, 'reloaded-revealed-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    expect(problems.filter((line) => !line.includes('favicon'))).toEqual([]);
  });

  test('a phase without failures shows neither pill nor peek', async ({ page, request }) => {
    test.setTimeout(120000);
    const problems = collectPageProblems(page);
    const label = uniqueLabel();
    const finalText = `E2E activity phase reply done ${label}`;
    await setPhaseLabel(request);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, PHASE_ENDPOINT);
    await selectEphemeralMCP(page);
    const run = await sendMessage(page, `E2E_ACTIVITY_PHASE_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(finalText)).toBeVisible({ timeout: 60000 });
    const header = messagesView(page).getByRole('button', { name: PHASE_LABEL, exact: true });
    await expect(header).toBeVisible({ timeout: 30000 });
    await expect(messagesView(page).getByTestId('failed-reveal-pill')).toHaveCount(0);
    await expect(messagesView(page).getByTestId('activity-phase-failed-peek')).toHaveCount(0);
    await shot(page, 'clean-collapsed');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await shot(page, 'clean-open');
    /** Groups inside a settled phase start collapsed; the phase summary speaks for them. */
    const group = messagesView(page).getByTestId('tool-call-group-panel').first();
    const groupHeader = group.locator('xpath=preceding-sibling::div[1]//button').first();
    await groupHeader.click();
    await expect(messagesView(page).locator('[data-testid="tool-call"]').first()).toBeVisible();
    await shot(page, 'clean-open-group');

    const phaseRail = messagesView(page)
      .getByTestId('activity-phase-panel')
      .locator('> div > [data-testid="fold-rail"]');
    const groupRail = group.locator('> div > [data-testid="fold-rail"]');
    const phaseLabel = header.getByText(PHASE_LABEL, { exact: true });
    const beforeHover = await phaseLabel.boundingBox();
    await phaseRail.hover();
    await expect(header.getByTestId('fold-rail-knob')).toBeVisible();
    expect(await phaseLabel.boundingBox()).toEqual(beforeHover);

    const groupLabel = groupHeader.locator('[role="status"]');
    const beforeGroupHover = await groupLabel.boundingBox();
    await groupRail.hover();
    await expect(groupHeader.getByTestId('fold-rail-knob')).toBeVisible();
    expect(await groupLabel.boundingBox()).toEqual(beforeGroupHover);

    /** Keep room below the historical fold so collapse cannot clamp away an overlap. */
    const phaseCard = messagesView(page).getByTestId('activity-phase-card');
    await phaseCard.evaluate((card) => {
      const spacer = document.createElement('div');
      spacer.style.height = '1200px';
      card.after(spacer);
    });
    await group.locator('> div > div').evaluate((rows) => {
      (rows as HTMLElement).style.paddingBottom = '1200px';
    });
    await groupRail.click({ position: { x: 12, y: 900 } });
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'false');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(async () => {
        const phaseBox = await header.boundingBox();
        const groupBox = await groupHeader.boundingBox();
        return phaseBox != null && groupBox != null && groupBox.y >= phaseBox.y + phaseBox.height;
      })
      .toBe(true);
    const isPointerAccessible = (button: typeof header) =>
      button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.left + 12, box.top + box.height / 2));
      });
    await expect(groupHeader).toBeInViewport();
    await expect.poll(() => isPointerAccessible(groupHeader)).toBe(true);
    await shot(page, 'nested-rail-revealed');

    await phaseRail.locator('..').evaluate((rows) => {
      (rows as HTMLElement).style.paddingBottom = '1200px';
    });
    await phaseRail.click({ position: { x: 12, y: 900 } });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(header).toBeInViewport();
    await expect.poll(() => isPointerAccessible(header)).toBe(true);
    await shot(page, 'phase-rail-revealed');
    expect(problems.filter((line) => !line.includes('favicon'))).toEqual([]);
  });
});
