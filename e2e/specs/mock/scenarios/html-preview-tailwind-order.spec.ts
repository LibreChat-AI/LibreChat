import { randomUUID } from 'node:crypto';
import type { FrameLocator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { expect, test } from '../fixtures';
import { messagesView } from '../helpers';

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';

/** The mock profile blocks every service worker in the context, and Sandpack's static preview
 *  serves the artifact's files from one inside the preview iframe. */
test.use({ serviceWorkers: 'allow' });

/** The page from #16841: element rules of its own, plus Tailwind utility classes on the `<p>`. */
const markup = (head = '') =>
  [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Test</title>',
    head,
    '<style>',
    '  body { margin: 32px; font-family: Arial, sans-serif }',
    '  h1 { font-size: 64px; color: #0a5; margin: 0 0 16px }',
    '  h2 { font-size: 40px }',
    '</style></head>',
    '<body>',
    '  <h1>Heading 64px</h1>',
    '  <h2>Subheading 40px</h2>',
    '  <p class="text-4xl font-bold text-blue-600">Tailwind classes</p>',
    '</body></html>',
  ].join('\n');

const artifact = (html: string) =>
  [
    ':::artifact{identifier="e2e-tailwind-order" type="text/html" title="page.html"}',
    '````',
    html,
    '````',
    ':::',
  ].join('\n');

/** Seeds one assistant message holding the artifact and opens its rendered preview. */
async function openPreview(page: Page, conversationId: string, text: string) {
  const userEmail = getE2EUser().email;
  await seedConversations(userEmail, [
    { conversationId, title: 'Tailwind order', updatedAt: new Date() },
  ]);
  await seedMessages(userEmail, conversationId, [
    {
      messageId: randomUUID(),
      parentMessageId: ROOT_PARENT,
      text,
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
    },
  ]);

  await page.goto(`/c/${conversationId}`, { timeout: 10000 });
  await messagesView(page)
    .getByRole('button', {
      name: 'Open artifact: page.html. Opens as a rendered preview',
      exact: true,
    })
    .click();
  const preview = page.locator('#artifact-viewer iframe').contentFrame();
  await expect(preview.locator('h1')).toBeVisible({ timeout: 20000 });
  return preview;
}

/** Computed styles inside the preview, once Tailwind has compiled its generated style. */
const styles = (preview: FrameLocator) =>
  preview.locator('body').evaluate(() => {
    const read = (selector: string) =>
      getComputedStyle(document.querySelector(selector) as Element);
    return {
      tailwind: [...document.head.querySelectorAll('style')].some((style) =>
        style.textContent?.includes('! tailwindcss v'),
      ),
      h1: read('h1').fontSize,
      h2: read('h2').fontSize,
      margin: read('body').marginTop,
      utility: read('p').fontSize,
    };
  });

/** These load the default hosted static bundler and the Tailwind Play CDN, as a real preview does. */
test.describe('Tailwind order in HTML artifact previews', () => {
  test.describe.configure({ timeout: 60000 });

  const ordered =
    'an HTML preview keeps the page CSS over Tailwind preflight while utilities still apply ' +
    '@scenario:html-preview-page-css-beats-tailwind-preflight';
  test(ordered, async ({ page }) => {
    const conversationId = randomUUID();
    try {
      const preview = await openPreview(page, conversationId, artifact(markup()));
      await expect
        .poll(() => styles(preview), { timeout: 20000 })
        .toEqual({ tailwind: true, h1: '64px', h2: '40px', margin: '32px', utility: '36px' });
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  const standalone =
    'an HTML preview that loads Tailwind itself keeps the cascade it has standalone ' +
    '@scenario:html-preview-own-tailwind-keeps-standalone-cascade';
  test(standalone, async ({ page }) => {
    const conversationId = randomUUID();
    try {
      const cdn = '<script src="https://cdn.tailwindcss.com"></script>';
      const preview = await openPreview(page, conversationId, artifact(markup(cdn)));
      /** Opened directly, the page's own Tailwind output follows its styles, so preflight wins. */
      await expect
        .poll(() => styles(preview), { timeout: 20000 })
        .toEqual({ tailwind: true, h1: '16px', h2: '16px', margin: '0px', utility: '36px' });
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
