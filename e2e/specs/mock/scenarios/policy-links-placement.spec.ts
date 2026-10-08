import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';

/**
 * A policy link is read where it is agreed to. Registration states the consent
 * with both links, and the welcome screen a conversation starts from carries
 * them under its composer; the conversation itself does not, on every turn of
 * every thread. What a conversation keeps is the operator's own custom footer.
 *
 * The second scenario is the layout half of the same change: the footer bar is
 * absolutely positioned in a zero-height wrapper, so the composer reserves its
 * band. A deployment that configures policy links and nothing else now paints
 * no bar in a conversation, so it must not reserve one either.
 *
 * The footer is hidden below `sm`, so this runs on the desktop viewport it
 * describes.
 */

const COMPOSER = '[data-testid="composer-surface"]';
const PRIVACY_URL = 'https://example.com/privacy';
const TERMS_URL = 'https://example.com/terms';

test.use({ viewport: { width: 1280, height: 800 } });

/** The harness deployment configures no policies, so a spec that needs them
 *  answers the startup config for itself rather than changing the config every
 *  other spec reads. The rest of `interface` is preserved: replacing it would
 *  take permissions and capabilities off the page with it. */
async function withPolicies(page: Page, policies: Record<string, unknown>) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, interface: { ...config.interface, ...policies } },
    });
  });
}

async function composerBottom(page: Page) {
  const box = await page.locator(COMPOSER).boundingBox();
  expect(box).not.toBeNull();
  return Math.round((box?.y ?? 0) + (box?.height ?? 0));
}

test.describe('policy link placement', () => {
  test('the policy links leave a started conversation @scenario:policy-links-leave-a-started-conversation', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: 'Policy link placement', updatedAt: new Date() },
    ]);

    try {
      await withPolicies(page, {
        privacyPolicy: { externalUrl: PRIVACY_URL },
        termsOfService: { externalUrl: TERMS_URL },
      });

      await page.goto('/c/new', { timeout: 15000 });
      await expect(page.locator(`a[href="${PRIVACY_URL}"]`)).toBeVisible({ timeout: 15000 });
      await expect(page.locator(`a[href="${TERMS_URL}"]`)).toBeVisible();

      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      /** The config has answered by now: the welcome screen above read it from
       *  the same cache, so an empty count here is the placement and not a
       *  request still in flight. */
      await expect(page.locator(`a[href="${PRIVACY_URL}"]`)).toHaveCount(0);
      await expect(page.locator(`a[href="${TERMS_URL}"]`)).toHaveCount(0);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('an empty custom footer reserves no band either @scenario:an-empty-custom-footer-leaves-no-band-in-a-conversation', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: 'Empty custom footer', updatedAt: new Date() },
    ]);

    try {
      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      const withoutFooter = await composerBottom(page);

      /** An operator who sets the footer to nothing is suppressing the welcome
       *  screen's disclaimer; a conversation renders no bar for it. */
      await page.route('**/api/config', async (route) => {
        const response = await route.fetch();
        const config = await response.json();
        await route.fulfill({ response, json: { ...config, customFooter: '' } });
      });
      await page.reload({ timeout: 15000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();

      expect(
        await composerBottom(page),
        'the conversation reserved a band for an empty footer',
      ).toBe(withoutFooter);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a deployment with policies alone reserves no band in a conversation @scenario:a-policy-only-deployment-leaves-no-band-in-a-conversation', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: 'Policy only clearance', updatedAt: new Date() },
    ]);

    try {
      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      const withoutPolicies = await composerBottom(page);

      await withPolicies(page, {
        privacyPolicy: { externalUrl: PRIVACY_URL },
        termsOfService: { externalUrl: TERMS_URL },
      });
      await page.reload({ timeout: 15000 });
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      await expect(page.locator(`a[href="${PRIVACY_URL}"]`)).toHaveCount(0);

      expect(
        await composerBottom(page),
        'the conversation reserved a band for a bar it does not paint',
      ).toBe(withoutPolicies);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
