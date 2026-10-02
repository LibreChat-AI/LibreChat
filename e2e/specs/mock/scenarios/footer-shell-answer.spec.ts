import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';

/**
 * The document says whether the deployment configured a footer, and the composer
 * lays out against that answer before `/api/config` has one. The answer is the
 * deployment's own configuration, so two cases have to keep working: a document
 * that carries no answer at all (the Vite dev server serves `client/index.html`
 * itself, and a proxy could strip the script), and a caller whose resolved
 * configuration disagrees with it, since a per-tenant, role or user override of
 * `customFooter` is resolved only by `/api/config`. In both, the resolved answer
 * is the one that decides, and the bar never covers the composer once it has.
 *
 * The footer is hidden below `sm`, so this runs on the desktop viewport it
 * describes.
 */

const COMPOSER = '[data-testid="composer-surface"]';
const CUSTOM_FOOTER = 'Operator policy footer';
const SHELL_SENTINEL = 'data-librechat-configured-footer="true"';

declare global {
  interface Window {
    __LIBRECHAT_CONFIG__?: { hasConfiguredFooter?: boolean };
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

/** Serves the shell through `rewrite`, so a test can take the server's own
 *  answer out of the document or leave it as the deployment emitted it. */
async function serveShell(page: Page, rewrite: (html: string) => string) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      return route.fallback();
    }
    const response = await route.fetch();
    await route.fulfill({ response, body: rewrite(await response.text()) });
  });
}

/** Answers the startup config with footer configuration the shell did not
 *  report, which is what a config override for this caller looks like. */
async function serveResolvedConfig(page: Page, overrides: Record<string, unknown>) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({ response, json: { ...config, ...overrides } });
  });
}

/** The footer bar is absolutely positioned in a zero-height wrapper: nothing but
 *  the composer's own clearance keeps it off the composer's action row. */
async function expectFooterBelowComposer(page: Page, footer: Locator) {
  const composerBox = await page.locator(COMPOSER).boundingBox();
  const footerBox = await footer.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(footerBox?.y ?? 0, 'the footer overlaps the composer').toBeGreaterThanOrEqual(
    (composerBox?.y ?? 0) + (composerBox?.height ?? 0),
  );
}

test.describe('footer answer in the shell', () => {
  test('a document with no footer answer still loads and follows the config @scenario:a-shell-without-the-footer-answer-follows-the-config', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: 'Shell without an answer', updatedAt: new Date() },
    ]);

    try {
      await serveResolvedConfig(page, { customFooter: CUSTOM_FOOTER });
      await serveShell(page, (html) =>
        html.replace(new RegExp(`<script [^>]*${SHELL_SENTINEL}[^>]*>[\\s\\S]*?</script>`), ''),
      );

      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      expect(
        await page.evaluate(() => window.__LIBRECHAT_CONFIG__?.hasConfiguredFooter),
        'the document was expected to carry no answer',
      ).toBeUndefined();

      /** No answer reads as the default deployment, and the resolved config is
       *  what puts the bar there — with the clearance it needs. */
      const footer = page.getByText(CUSTOM_FOOTER);
      await expect(footer).toBeVisible({ timeout: 15000 });
      await expectFooterBelowComposer(page, footer);

      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill('still reachable');
      await expect(input).toHaveValue('still reachable');
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a footer this caller alone has still clears the composer @scenario:an-override-custom-footer-clears-the-composer', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: 'Override custom footer', updatedAt: new Date() },
    ]);

    try {
      /** The harness deployment configures no footer, so its document says so:
       *  this caller's resolved configuration is the one that disagrees. */
      await serveResolvedConfig(page, { customFooter: CUSTOM_FOOTER });

      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      expect(
        await page.evaluate(() => window.__LIBRECHAT_CONFIG__?.hasConfiguredFooter),
        'the deployment was expected to report no configured footer',
      ).toBe(false);

      const footer = page.getByText(CUSTOM_FOOTER);
      await expect(footer).toBeVisible({ timeout: 15000 });
      await expectFooterBelowComposer(page, footer);

      /** The bar arrived after the first paint, so the check that matters is the
       *  composer's action row still taking its own clicks. */
      const composerBox = await page.locator(COMPOSER).boundingBox();
      await page
        .locator(COMPOSER)
        .click({ position: { x: 40, y: (composerBox?.height ?? 40) - 8 } });
      const input = page.getByRole('textbox', { name: 'Message input' });
      await input.fill('still reachable');
      await expect(input).toHaveValue('still reachable');
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
