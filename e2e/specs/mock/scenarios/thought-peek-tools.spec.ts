import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, selectMockEndpoint, sendMessage } from '../helpers';

const ENDPOINT = { label: 'Mock Provider F', model: 'mock-model-f' };
const MCP_SERVER_TITLE = 'E2E Memory';
const uniqueLabel = () => `peek-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

async function enableMemoryServer(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const item = page
    .getByRole('dialog', { name: 'Attach and tools' })
    .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
  await expect(item).toBeVisible();
  await item.click();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listitem', { name: MCP_SERVER_TITLE, exact: true })).toBeVisible();
}

/**
 * Counts every time the peek comes on screen in the conversation from now on, read back through
 * the handle. The page counts them itself because a peek can come and go between two looks from
 * here: a summary card folding in keeps its rows on screen for about a tenth of a second.
 */
async function countPeeks(page: Page) {
  return page.evaluateHandle(() => {
    const seen = { shown: 0 };
    let showing = false;
    new MutationObserver(() => {
      const peek = document.querySelector(
        '[data-testid="messages-view"] [data-testid="streaming-thought-peek"]',
      );
      const visible = peek != null && peek.getClientRects().length > 0;
      if (visible && !showing) {
        seen.shown += 1;
      }
      showing = visible;
    }).observe(document.body, { childList: true, subtree: true });
    return seen;
  });
}

/** How many looks, a tenth of a second apart, it took for the final text to land. */
async function looksUntilReply(page: Page, finalText: string) {
  const final = messagesView(page).getByText(finalText);
  let looks = 0;
  while (looks < 300 && !(await final.isVisible().catch(() => false))) {
    looks += 1;
    await page.waitForTimeout(100);
  }
  return looks;
}

/** A settled card folds in over the thought on the run's last commits, so counts are read after. */
async function runEnds(page: Page, finalText: string) {
  await expect(messagesView(page).getByText(finalText)).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
    timeout: 30000,
  });
}

test.describe('streaming thought peek', () => {
  test('the peek stays hidden when the Thoughts row is folded @scenario:thought-peek-only-while-thinking', async ({
    page,
  }) => {
    test.setTimeout(180000);

    /** Pure reasoning: the Thoughts row is inside the collapsed card. */
    const reasoning = uniqueLabel();
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, ENDPOINT);
    const pure = await countPeeks(page);
    const first = await sendMessage(page, `E2E_SLOW_THINK_REPLY:${reasoning}`);
    expect(first.ok()).toBeTruthy();
    await runEnds(page, `E2E slow think reply done ${reasoning}`);
    expect(await pure.evaluate((seen) => seen.shown), 'no peek under a collapsed phase').toBe(0);

    /** A thought that streams after a tool call never shows the peek. */
    const afterTool = uniqueLabel();
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    /** The endpoint choice persists across new chats on some viewports only. */
    const trigger = page.getByRole('button', { name: 'Select a model' }).first();
    await expect(trigger).toBeVisible();
    /** Target restoration can finish after the selector first becomes visible. */
    await expect(trigger).not.toHaveText('Select a model');
    if (!(await trigger.textContent())?.includes(ENDPOINT.model)) {
      await selectMockEndpoint(page, ENDPOINT);
    }
    await enableMemoryServer(page);
    const toolRun = await countPeeks(page);
    const second = await sendMessage(page, `E2E_TOOL_THEN_THINK_REPLY:${afterTool}`);
    expect(second.ok()).toBeTruthy();
    const finalText = `E2E tool then think reply done ${afterTool}`;
    expect(await looksUntilReply(page, finalText), 'watched while streaming').toBeGreaterThan(5);
    await runEnds(page, finalText);
    expect(await toolRun.evaluate((seen) => seen.shown), 'peek after a tool call').toBe(0);
    /** The run really was a tool call followed by a thought, not a bare reply. */
    await expect(
      messagesView(page)
        .getByRole('button', { name: /Thoughts|Thinking|remember|Memory/i })
        .first(),
    ).toBeVisible();
  });
});
