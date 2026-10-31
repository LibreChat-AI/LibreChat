import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  sendMessage,
  selectMockEndpoint,
} from '../helpers';

/**
 * The composer's text field and action slot, drawn by the chat package: a long draft collapses
 * and expands without losing the text field, Enter sends and Shift+Enter breaks the line, and
 * while a run streams the slot shows Stop, swaps to the during-run send once there is text, and
 * returns to Stop when the text is cleared.
 */
test.describe.configure({ timeout: 120_000 });

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });

async function openComposer(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const input = messageInput(page);
  await input.click();
  return input;
}

test.describe('composer field', () => {
  test('a long draft collapses and expands on focus @scenario:composer-collapse-toggle', async ({
    page,
  }) => {
    const input = await openComposer(page);
    await input.fill(Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n'));
    const marker = await input.evaluate((node) => {
      node.dataset.e2eMarker = 'kept';
      return node.dataset.e2eMarker;
    });
    expect(marker).toBe('kept');

    await page.getByRole('button', { name: 'Collapse Chat' }).click();
    await expect(page.getByRole('button', { name: 'Expand Chat' })).toBeVisible();
    const collapsed = await input.evaluate((node) => node.getBoundingClientRect().height);

    await input.click();
    await expect(page.getByRole('button', { name: 'Collapse Chat' })).toBeVisible();
    await expect
      .poll(() => input.evaluate((node) => node.getBoundingClientRect().height))
      .toBeGreaterThan(collapsed);
    await expect(input).toHaveAttribute('data-e2e-marker', 'kept');
    await expect(input).toHaveValue(/line 8$/);
  });

  test('Shift+Enter breaks the line and Enter sends @scenario:composer-enter-to-send', async ({
    page,
  }) => {
    const input = await openComposer(page);
    const label = `enter-${Date.now()}`;
    await input.pressSequentially('first');
    await input.press('Shift+Enter');
    await input.pressSequentially('second');
    await expect(input).toHaveValue('first\nsecond');

    await input.fill(replyPrompt(label));
    await input.press('Enter');
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
    await expect(input).toHaveValue('');
  });

  test('the action slot follows the run and the draft @scenario:composer-action-slot-during-run', async ({
    page,
  }) => {
    await openComposer(page);
    const run = await sendMessage(page, `E2E_SLOW_REPLY:slot-${Date.now()}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('chunk-010')).toBeVisible({ timeout: 15000 });

    const stop = page.getByTestId('stop-generation-button');
    const duringRunSend = page.getByTestId('during-run-send-button');
    await expect(stop).toBeVisible();
    await expect(duringRunSend).toHaveCount(0);

    const input = messageInput(page);
    await input.fill('actually, keep it short');
    await expect(duringRunSend).toBeVisible();
    await expect(stop).toBeHidden();

    await input.fill('');
    await expect(stop).toBeVisible();
    await expect(duringRunSend).toHaveCount(0);

    await stop.click();
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 15000 });
  });
});
