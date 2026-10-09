import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  enableCodeInterpreter,
  selectMockEndpoint,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
} from '../helpers';

/**
 * A tool call is opened by its run step, grows through argument deltas and is
 * settled by its completion, all folded into one part at the step's index by
 * the tool reducers in `client/src/hooks/SSE/steps/tools.ts`.
 */

const FINAL_TEXT = 'E2E execute_code complete';
const TOOL_OUTPUT = 'stdout: E2E code exec ok';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** The code-execution card's status toggle; a slow run appends its duration to the name. */
const toolCard = (page: Page) => messagesView(page).getByRole('button', { name: /^Ran command/ });
const toolOutput = (page: Page) => messagesView(page).getByText(TOOL_OUTPUT, { exact: true });

/** True when `first` sits before `second` in document order. */
async function precedes(first: Locator, second: Locator): Promise<boolean> {
  const handle = await second.elementHandle();
  return first.evaluate(
    (node, other) =>
      other != null && (node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
    handle,
  );
}

async function expectOneToolCardBeforeReply(page: Page, label: string) {
  const reply = messagesView(page).getByText(`${FINAL_TEXT}: ${label}`, { exact: true });
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(reply).toHaveCount(1);
  await expect(toolCard(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(toolOutput(page)).toHaveCount(1);
  expect(await precedes(toolCard(page), reply)).toBe(true);
  expect(await precedes(toolOutput(page), reply)).toBe(true);
}

test.describe('tool call steps', () => {
  test('a tool call renders once, ahead of the reply that follows it, live and after reload @scenario:tool-call-renders-once-before-its-reply', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('tool');
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await enableCodeInterpreter(page);

    const response = await sendMessageAndWaitForCompletion(page, `E2E_EXECUTE_CODE:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30_000,
    });
    await expectOneToolCardBeforeReply(page, label);

    await page.reload({ timeout: 10_000 });
    await expectOneToolCardBeforeReply(page, label);
  });

  test('a lone settled command opens its output without a click and reads Ran command @scenario:lone-tool-call-opens-and-reads-ran', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('lone');
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await enableCodeInterpreter(page);

    const response = await sendMessageAndWaitForCompletion(page, `E2E_EXECUTE_CODE:${label}`);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30_000,
    });
    await expect(toolCard(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(toolOutput(page)).toBeVisible();
  });
});

test.describe('tool call groups', () => {
  test.skip(({ isMobile }) => isMobile === true, 'composer MCP picker is desktop-only');

  test('opening a group of two calls leaves each call collapsed @scenario:multi-call-group-keeps-calls-collapsed', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('pair');
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    /** No `activityLabel` here, so the group keeps its generic "Ran 2 actions" header. */
    await selectMockEndpoint(page, { label: 'Mock Provider D', model: 'mock-model-d' });
    await page.getByRole('button', { name: 'Attach and tools' }).click();
    const server = page
      .getByRole('dialog', { name: 'Attach and tools' })
      .getByRole('button', { name: /^E2E Memory\b/ });
    await server.click();
    await expect(server).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');

    const response = await sendMessageAndWaitForCompletion(page, `E2E_ACTIVITY_REPLY:${label}`, {
      timeout: 60_000,
    });
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E activity reply done ${label}`)).toBeVisible({
      timeout: 30_000,
    });

    const header = messagesView(page).getByRole('button', { name: /^Ran 2 actions/ });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    const calls = messagesView(page).getByRole('button', { name: /^Ran remember_fact/ });
    await expect(calls).toHaveCount(2);
    for (const call of await calls.all()) {
      await expect(call).toHaveAttribute('aria-expanded', 'false');
    }
  });
});
