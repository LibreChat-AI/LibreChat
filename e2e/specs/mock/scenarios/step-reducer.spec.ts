import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  thinkPrompt,
  replyText,
} from '../helpers';

/**
 * Streamed content parts are folded into the response by the step reducers in
 * `client/src/hooks/SSE/steps`, each at its step's index. These scenarios pin
 * what that looks like on screen, live and after the persisted copy reloads.
 */

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const lastAssistant = (page: Page) => messagesView(page).locator('.message-render').last();

/** True when `first` sits before `second` in document order. */
async function precedes(first: Locator, second: Locator): Promise<boolean> {
  const handle = await second.elementHandle();
  return first.evaluate(
    (node, other) =>
      other != null && (node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
    handle,
  );
}

async function expectReasoningBeforeReply(page: Page, label: string) {
  const assistant = lastAssistant(page);
  const thoughts = assistant.getByText('Thoughts', { exact: true }).first();
  const reply = assistant.getByText(replyText(label), { exact: true });
  await expect(thoughts).toBeVisible({ timeout: 30_000 });
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(reply).toHaveCount(1);
  expect(await precedes(thoughts, reply)).toBe(true);
}

test.describe('step reducer', () => {
  test('streamed reasoning renders ahead of its reply text, live and after reload @scenario:reasoning-renders-before-its-reply-text', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const label = uniqueLabel('think');
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessageAndWaitForCompletion(page, thinkPrompt(label));
    expect(response.ok()).toBeTruthy();
    await expectReasoningBeforeReply(page, label);

    await page.reload({ timeout: 10_000 });
    await expectReasoningBeforeReply(page, label);
  });

  test('a manual compaction streams its summary into the conversation and keeps it after reload @scenario:manual-compaction-summary-survives-reload', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const label = uniqueLabel('compact');
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await sendMessageAndWaitForCompletion(page, `tell me about ${label}`);

    await page.getByTestId('token-usage').click();
    await page.getByRole('button', { name: 'Compact context' }).click();

    const compacted = messagesView(page).getByText('You compacted the context', { exact: true });
    await expect(compacted).toBeVisible({ timeout: 60_000 });
    await expect(compacted).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 30_000,
    });

    await page.reload({ timeout: 10_000 });
    await expect(compacted).toBeVisible({ timeout: 30_000 });
    await expect(compacted).toHaveCount(1);
  });
});
