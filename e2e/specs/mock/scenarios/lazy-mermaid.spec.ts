import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/**
 * Mermaid is about 3 MB of JavaScript, and `useMermaid` imports it on demand. The chunk used to
 * load at boot anyway: the build's chunk groups captured shared modules the boot chunks import
 * (Vite's preload helper, the Buffer shim, DOMPurify, uuid, dayjs) into the mermaid chunk, so
 * every page downloaded and evaluated it before its first API request, on the path to the
 * largest contentful paint.
 */

const MERMAID_CHUNK = /\/assets\/mermaid\.[\w-]+\.js$/;

function recordMermaidRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    if (MERMAID_CHUNK.test(new URL(request.url()).pathname)) {
      requested.push(request.url());
    }
  });
  return requested;
}

test.describe('the mermaid chunk', () => {
  test('a chat without diagrams never downloads mermaid @scenario:a-chat-without-diagrams-never-downloads-mermaid', async ({
    page,
  }) => {
    const requested = recordMermaidRequests(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    const response = await sendMessageAndWaitForCompletion(page, 'Hello there');
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByText('Hello there')).toBeVisible();

    expect(requested).toEqual([]);
  });

  test('a diagram reply loads mermaid on demand and renders it @scenario:a-diagram-reply-loads-mermaid-on-demand', async ({
    page,
  }) => {
    const requested = recordMermaidRequests(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    expect(requested, 'the boot must not fetch mermaid').toEqual([]);

    const response = await sendMessage(page, 'E2E_MERMAID_ARTIFACT_REPLY');
    expect(response.ok()).toBeTruthy();
    await expect(messagesView(page).getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
    expect(requested).not.toHaveLength(0);
  });
});
