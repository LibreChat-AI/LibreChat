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

test.describe('message actions', () => {
  test('a finished reply offers a copy action that shows a focus ring on keyboard focus @scenario:message-actions-render', async ({
    page,
  }) => {
    const label = `actions-${Date.now()}`;
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, ENDPOINT);
    const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible();

    const copy = messagesView(page).getByRole('button', { name: 'Copy to clipboard' }).last();
    await copy.focus();
    await expect(copy).toBeVisible();
    await expect(copy).toBeFocused();
    const ring = await copy.evaluate((node) => getComputedStyle(node).boxShadow);
    expect(ring).not.toBe('none');
  });
});
