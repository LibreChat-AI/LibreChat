import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  isAgentsStream,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
} from '../helpers';

/**
 * A turn sent from a conversation with other branches builds its history from the branch the
 * turn extends and nothing else. Each regenerated reply is a sibling the turn must not carry, so
 * the model-facing history is read back through the fake model's history assertion.
 */

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop generating' });
const messageRows = (page: Page) => messagesView(page).locator('.message-render');

/** The counted reply ends in its ordinal, so the replies of one prompt tell apart by `#n`. */
const countedPrompt = (label: string) => `E2E_COUNTED_REPLY:${label}`;
const countedText = (label: string, ordinal: number) => `E2E counted reply ${label} #${ordinal}`;

async function startWithTwoAnswers(page: Page, label: string) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

  const first = await sendMessageAndWaitForCompletion(page, countedPrompt(label));
  expect(first.ok()).toBeTruthy();
  const answer = messageRows(page).last();
  await expect(answer.locator('.message-content')).toHaveText(countedText(label, 1), {
    timeout: 30_000,
  });

  await answer.hover();
  const [regenerated] = await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30_000 }),
    answer.getByRole('button', { name: 'Regenerate', exact: true }).last().click(),
  ]);
  expect(regenerated.ok()).toBeTruthy();
  await expect(page.getByText('2 / 2')).toBeVisible({ timeout: 30_000 });
  await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });
  await expect(messageRows(page).last().locator('.message-content')).toHaveText(
    countedText(label, 2),
    { timeout: 30_000 },
  );
}

/** Asks the fake model whether `token` reached it in the history of this turn. */
async function historyHolds(page: Page, token: string, holds: boolean) {
  const response = await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${token}`);
  expect(response.ok()).toBeTruthy();
  const verdict = holds ? 'present' : 'absent';
  await expect(
    messagesView(page).getByText(`E2E history assertion ${verdict}: ${token}`),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe('branch history', () => {
  test.setTimeout(120_000);

  test('a follow-up after a regenerated answer continues from the active branch @scenario:a-follow-up-after-a-regenerated-answer-continues-from-the-active-branch', async ({
    page,
  }) => {
    await startWithTwoAnswers(page, uniqueLabel('branch-new'));

    await historyHolds(page, '#2', true);
    await historyHolds(page, '#1', false);
  });

  test('a follow-up after paging back to the older answer continues from that answer @scenario:a-follow-up-after-paging-back-to-the-older-answer-continues-from-that-answer', async ({
    page,
  }) => {
    const label = uniqueLabel('branch-old');
    await startWithTwoAnswers(page, label);

    await page.getByRole('button', { name: 'Previous sibling message' }).click();
    await expect(page.getByText('1 / 2')).toBeVisible();
    await expect(messageRows(page).last().locator('.message-content')).toHaveText(
      countedText(label, 1),
    );

    await historyHolds(page, '#1', true);
    await historyHolds(page, '#2', false);
  });
});
