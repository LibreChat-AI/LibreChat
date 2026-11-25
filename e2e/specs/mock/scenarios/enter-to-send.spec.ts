import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, isAgentsStream, messagesView, replyPrompt, replyText } from '../helpers';

/**
 * Enter sends and Shift+Enter inserts a newline for anyone who never saved the
 * preference, while a saved opt-out (Ctrl/Cmd+Enter to send) is kept.
 */

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });

async function openFreshChat(page: Page, saved?: boolean) {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.evaluate((value) => {
    localStorage.removeItem('enterToSend');
    if (value !== undefined) {
      localStorage.setItem('enterToSend', JSON.stringify(value));
    }
  }, saved);
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await expect(messageInput(page)).toBeVisible();
}

async function expectSent(page: Page, label: string, key: string) {
  const input = messageInput(page);
  await input.fill(replyPrompt(label));
  await Promise.all([page.waitForResponse(isAgentsStream, { timeout: 30000 }), input.press(key)]);
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
}

test.describe('enter to send default', () => {
  test('Enter sends a message when no preference is saved @scenario:enter-sends-message-with-no-saved-preference', async ({
    page,
  }) => {
    await openFreshChat(page);

    await messageInput(page).fill('hi');
    await expect(page.locator('#composer-hint-0')).toContainText('Enter to send');

    await expectSent(page, 'enter-default', 'Enter');
    await expect(page).toHaveURL(/\/c\/(?!new$)[^/]+$/);
  });

  test('Shift+Enter inserts a newline without sending when no preference is saved @scenario:shift-enter-inserts-newline-by-default', async ({
    page,
  }) => {
    await openFreshChat(page);
    let streamed = false;
    page.on('response', (response) => {
      if (isAgentsStream(response)) {
        streamed = true;
      }
    });

    const input = messageInput(page);
    await input.fill('first line');
    await input.press('Shift+Enter');
    await input.pressSequentially('second line');

    await expect(input).toHaveValue('first line\nsecond line');
    await expect(page).toHaveURL(/\/c\/new$/);
    expect(streamed).toBe(false);
  });

  test('a saved Ctrl/Cmd+Enter preference keeps Enter as a newline @scenario:saved-modifier-enter-preference-is-kept', async ({
    page,
  }) => {
    await openFreshChat(page, false);

    const input = messageInput(page);
    await input.fill('first line');
    await input.press('Enter');
    await expect(input).toHaveValue('first line\n');
    await expect(page).toHaveURL(/\/c\/new$/);

    await expectSent(page, 'modifier-saved', 'ControlOrMeta+Enter');
  });
});
