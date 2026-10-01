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
const toolCard = (page: Page) =>
  messagesView(page).getByRole('button', { name: /^Finished running/ });
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
});
