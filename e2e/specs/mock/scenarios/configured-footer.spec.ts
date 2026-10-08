import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';

/**
 * The generic model disclaimer belongs to the welcome screen. A deployment's own
 * footer is different content: an operator who sets `customFooter` puts policy or
 * branding there, and the authenticated chat is where it is read. Scoping the
 * disclaimer to the welcome screen must not take that configuration off the
 * conversation screen with it.
 *
 * The footer is hidden below `sm`, so this runs on the desktop viewport it
 * describes.
 */

const CUSTOM_FOOTER = 'Operator policy footer';
const CONVERSATION_TITLE = 'Configured footer';

test.use({ viewport: { width: 1280, height: 800 } });

/** Serve the deployment's startup config with a custom footer configured,
 *  without changing the shared harness config every other spec reads. */
async function withConfiguredFooter(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, customFooter: CUSTOM_FOOTER },
    });
  });
}

test.describe('configured footer', () => {
  test("an operator's footer stays in the conversation @scenario:configured-footer-stays-in-a-conversation", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: CONVERSATION_TITLE, updatedAt: new Date() },
    ]);

    try {
      await withConfiguredFooter(page);

      await page.goto('/c/new', { timeout: 10000 });
      await expect(page.getByText(CUSTOM_FOOTER)).toBeVisible();
      /** The generic disclaimer is replaced by the operator's content, as before. */
      await expect(page.locator('a[href="https://librechat.ai"]')).toHaveCount(0);

      await page.goto(`/c/${conversationId}`, { timeout: 10000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await expect(page.getByText(CUSTOM_FOOTER)).toBeVisible();
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
