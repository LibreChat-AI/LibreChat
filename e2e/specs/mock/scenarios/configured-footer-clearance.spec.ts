import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';

/**
 * The footer is an absolutely positioned bar in a zero-height wrapper, so the
 * composer above it is what reserves its band. A conversation that keeps a
 * deployment's configured footer therefore has to keep that clearance too, or
 * the bar paints over the composer's action row and takes the clicks meant for
 * it.
 */

const COMPOSER = '[data-testid="composer-surface"]';
const CUSTOM_FOOTER = 'Operator policy footer';
const CONVERSATION_TITLE = 'Configured footer clearance';

test.use({ viewport: { width: 1280, height: 800 } });

async function withConfiguredFooter(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({ response, json: { ...config, customFooter: CUSTOM_FOOTER } });
  });
}

test.describe('configured footer clearance', () => {
  test('a configured footer never covers the composer @scenario:configured-footer-clears-the-composer', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: CONVERSATION_TITLE, updatedAt: new Date() },
    ]);

    try {
      await withConfiguredFooter(page);
      await page.goto(`/c/${conversationId}`, { timeout: 10000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      const footer = page.getByText(CUSTOM_FOOTER);
      await expect(footer).toBeVisible();

      const composerBox = await page.locator(COMPOSER).boundingBox();
      const footerBox = await footer.boundingBox();
      expect(composerBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      const composerBottom = (composerBox?.y ?? 0) + (composerBox?.height ?? 0);
      expect(
        footerBox?.y ?? 0,
        'the configured footer overlaps the composer',
      ).toBeGreaterThanOrEqual(composerBottom);

      /** Overlap is not only visual: the bar would take the composer's clicks. */
      const input = page.getByRole('textbox', { name: 'Message input' });
      await page
        .locator(COMPOSER)
        .click({ position: { x: 40, y: (composerBox?.height ?? 40) - 8 } });
      await input.fill('still reachable');
      await expect(input).toHaveValue('still reachable');
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
