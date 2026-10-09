import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  mockReply,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from './helpers';

test.describe('endpoint switching', () => {
  for (const endpoint of MOCK_ENDPOINTS) {
    test(`"${endpoint.label}" returns a streamed response`, async ({ page }) => {
      test.setTimeout(60000);
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

      await selectMockEndpoint(page, endpoint);

      const response = await sendMessageAndWaitForCompletion(page, `hello ${endpoint.model}`);
      expect(response.ok()).toBeTruthy();
      await expect(mockReply(page)).toBeVisible();
    });
  }
});
