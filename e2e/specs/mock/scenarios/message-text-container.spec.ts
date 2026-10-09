import { expect, test } from '@playwright/test';
import {
  NEW_CHAT_PATH,
  replyText,
  replyPrompt,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

const ENDPOINT = { label: 'Mock Provider A', model: 'mock-model-a' };

test.describe('message text containers', () => {
  test('both turns render their text in a dir=auto container marked data-message-text @scenario:message-text-container-direction', async ({
    page,
  }) => {
    const label = `text-container-${Date.now()}`;
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, ENDPOINT);
    const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(response.ok()).toBeTruthy();

    for (const text of [replyPrompt(label), replyText(label)]) {
      const container = messagesView(page)
        .getByText(text, { exact: true })
        .locator('xpath=ancestor::div[@data-message-text][1]');
      await expect(container).toHaveAttribute('dir', 'auto');
    }
  });
});
