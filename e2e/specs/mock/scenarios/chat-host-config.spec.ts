import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * The deployment config the chat acts on reaches it through the host's chat settings rather than
 * through the chat's own startup-config reads. These scenarios check what the chat does with it.
 */

test.describe('chat host config', () => {
  test('a reply offers rating feedback the deployment allows @scenario:reply-offers-feedback-from-host-config', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const label = `host-feedback-${Date.now()}`;
    await sendMessageAndWaitForCompletion(page, replyPrompt(label));
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 20000 });

    const thumbsUp = messagesView(page).getByRole('button', { name: 'Love this' }).last();
    await expect(thumbsUp).toBeVisible();
    await expect(thumbsUp).toHaveAttribute('aria-pressed', 'false');
  });
});
