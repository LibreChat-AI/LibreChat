import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
  thinkPrompt,
  thinkText,
} from '../helpers';

/**
 * The thought and web search disclosures open and close on a shared grid-rows transition. These
 * scenarios cover what a reader does with them: fold a thought with motion reduced, and open a
 * finished search's sources and details. Search conversations are routed fixtures.
 */
test.describe.configure({ timeout: 120_000 });

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const DONE = 'Part disclosures fixture done.';
const QUERY = 'css view transitions support';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openFinishedSearch(page: Page) {
  const conversationId = unique('e2e-part-disclosures');
  const now = new Date(0).toISOString();
  const messageId = `${conversationId}-msg`;
  const message = {
    messageId,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content: [
      {
        type: 'tool_call',
        tool_call: {
          id: 's1',
          name: 'web_search',
          args: JSON.stringify({ query: QUERY }),
          output: 'results',
          progress: 1,
          type: 'tool_call',
          runStepStatus: 'completed',
        },
      },
      { type: 'text', text: DONE },
    ],
    attachments: [
      {
        type: 'web_search',
        toolCallId: 's1',
        messageId,
        web_search: {
          turn: 0,
          organic: [{ link: 'https://developer.mozilla.org/', title: 'MDN on view transitions' }],
          topStories: [],
        },
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const conversation = {
    conversationId,
    title: 'Part disclosures',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const convoIdRe = escapeRe(conversationId);
  await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([message]),
    }),
  );
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
  await expect(messagesView(page).getByText(DONE)).toBeVisible({ timeout: 20000 });
}

test.describe('part disclosures', () => {
  test('a reader who prefers reduced motion folds a thought and its text leaves the page @scenario:reduced-motion-fold-removes-thought-text', async ({
    page,
  }) => {
    const label = unique('reduced-fold');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      window.localStorage.setItem('showThinking', 'true');
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, thinkPrompt(label));

    const message = messagesView(page).locator('.message-render').last();
    const header = message.getByRole('button', { name: /Thoughts/ }).first();
    const thought = message.getByText(thinkText(label));
    await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
    await expect(thought).toBeVisible();

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(thought).toHaveCount(0);

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(thought).toBeVisible();
  });

  test('a finished web search opens its sources, and its details show on focus @scenario:finished-web-search-opens-sources-and-shows-details-on-focus', async ({
    page,
  }) => {
    await openFinishedSearch(page);
    const view = messagesView(page);
    const row = view.getByRole('button', { name: /Searched the web/ }).first();
    const source = view.getByRole('link', { name: /MDN on view transitions/ });
    await expect(row).toBeVisible();
    if ((await row.getAttribute('aria-expanded')) === 'true') {
      await row.click();
      await expect(source).toHaveCount(0);
    }

    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', 'https://developer.mozilla.org/');

    await row.press('Enter');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(source).toHaveCount(0);

    const details = view.getByRole('button', { name: 'Search details' });
    const reveal = details.locator('xpath=..');
    /** The row still holds focus from the keyboard toggle, and focus anywhere in the row reveals it. */
    await row.evaluate((node) => node.blur());
    await page.mouse.move(0, 0);
    await expect(reveal).toHaveCSS('opacity', '0');
    await details.focus();
    await expect(reveal).toHaveCSS('opacity', '1');
    await expect(page.getByText(QUERY)).toBeVisible();
  });
});
