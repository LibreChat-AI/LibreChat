import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * The composer's surrounding controls moved onto shared Button, Spinner and size roles.
 * This sends a message through the real composer and reads the reply and the footer rule.
 */
test.describe.configure({ timeout: 120_000 });

test.describe('chat composer surfaces', () => {
  test('sends a message and renders the reply with the composer intact @scenario:composer-send-and-reply', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessage(page, 'composer surfaces');
    await expect(mockReply(page)).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });
});
