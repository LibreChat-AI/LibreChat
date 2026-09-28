import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, deleteMessagesByConversation, seedConversations } from '../db';

/**
 * Whether a conversation carries a footer decides where its composer sits, and
 * on a cold load of `/c/<id>` the startup config answers only after the composer
 * has already been painted. The server knows when it serves the document, so it
 * says so there and the composer lays out once — on a first-ever visit, with
 * nothing remembered from a previous one.
 */

const COMPOSER = '[data-testid="composer-surface"]';
const CUSTOM_FOOTER = 'Operator policy footer';
const CONVERSATION_TITLE = 'Cold load clearance';

declare global {
  interface Window {
    /** Every composer bottom painted since the document started. */
    __composerBottomSamples?: number[];
    /** The answers the server emitted with the document. */
    __LIBRECHAT_CONFIG__?: { hasConfiguredFooter?: boolean };
  }
}

test.use({ viewport: { width: 1280, height: 800 } });

/** A deployment whose footer the shell already reports: the e2e deployment
 *  configures none, so its own answer in the served document is flipped to the
 *  one a configured deployment would emit. The `/api/config` answer that agrees
 *  is deliberately slow — the composer has to be in its final position long
 *  before it lands. */
async function serveSlowConfiguredFooter(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    const delayed = Promise.withResolvers<void>();
    setTimeout(() => delayed.resolve(), 700);
    await delayed.promise;
    await route.fulfill({ response, json: { ...config, customFooter: CUSTOM_FOOTER } });
  });
  await installSampler(page, (html) =>
    html.replace('"hasConfiguredFooter":false', '"hasConfiguredFooter":true'),
  );
}

/** A sampler that records the composer's bottom from the document's first frame,
 *  served with the HTML so it is in place before the app's own scripts. */
async function installSampler(page: Page, serveShell: (html: string) => string = (html) => html) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      return route.fallback();
    }
    const response = await route.fetch();
    const sampler = `<script>
  window.__composerBottomSamples = [];
  (function sample() {
    var node = document.querySelector('[data-testid="composer-surface"]');
    if (node) {
      var bottom = Math.round(node.getBoundingClientRect().bottom * 100) / 100;
      var samples = window.__composerBottomSamples;
      if (samples.length === 0 || samples[samples.length - 1] !== bottom) {
        samples.push(bottom);
      }
    }
    if (window.__composerBottomSamples.length < 200) {
      requestAnimationFrame(sample);
    }
  })();
</script>`;
    const body = serveShell((await response.text()).replace('<head>', `<head>${sampler}`));
    await route.fulfill({ response, body });
  });
}

test.describe('cold load clearance', () => {
  test('the composer does not jump when the configured footer arrives @scenario:configured-footer-clearance-survives-a-cold-load', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: CONVERSATION_TITLE, updatedAt: new Date() },
    ]);

    try {
      await serveSlowConfiguredFooter(page);
      /** A first-ever visit: nothing about this deployment is remembered, and
       *  nothing has to be — the document carries the answer. */
      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      expect(
        await page.evaluate(() => window.__LIBRECHAT_CONFIG__?.hasConfiguredFooter),
        'the shell did not carry the deployment’s footer answer',
      ).toBe(true);
      /** Past the delayed config answer and any correction it would cause. */
      await expect(page.getByText(CUSTOM_FOOTER)).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(800);

      const samples = await page.evaluate(() => window.__composerBottomSamples ?? []);
      expect(samples.length).toBeGreaterThan(0);
      const settled = samples[samples.length - 1];
      const drift = Math.max(...samples.map((bottom) => Math.abs(bottom - settled)));
      expect(
        drift,
        `the composer moved when the configured footer arrived: ${JSON.stringify(samples)}`,
      ).toBeLessThanOrEqual(0.5);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});

/** A deployment that configures nothing is the common one, and its cold load has
 *  the same right to lay out once: reserving the band "just in case" and dropping
 *  it when the config answers moves the composer 24px down. */
async function serveSlowDefaultConfig(page: Page) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    const delayed = Promise.withResolvers<void>();
    setTimeout(() => delayed.resolve(), 700);
    await delayed.promise;
    await route.fulfill({ response, json: { ...config, customFooter: undefined } });
  });
  await installSampler(page);
}

test.describe('cold load clearance without a footer', () => {
  test('the composer does not jump when the config confirms no footer @scenario:default-clearance-survives-a-cold-load', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const conversationId = randomUUID();
    await seedConversations(getE2EUser().email, [
      { conversationId, title: 'Default clearance', updatedAt: new Date() },
    ]);

    try {
      await serveSlowDefaultConfig(page);
      await page.goto(`/c/${conversationId}`, { timeout: 15000 });
      await expect(page.locator(COMPOSER)).toBeVisible();
      /** Past the delayed answer and any correction it would cause. */
      await page.waitForTimeout(1800);

      const samples = await page.evaluate(() => window.__composerBottomSamples ?? []);
      expect(samples.length).toBeGreaterThan(0);
      const settled = samples[samples.length - 1];
      const drift = Math.max(...samples.map((bottom) => Math.abs(bottom - settled)));
      expect(
        drift,
        `the composer moved when the config answered: ${JSON.stringify(samples)}`,
      ).toBeLessThanOrEqual(0.5);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
