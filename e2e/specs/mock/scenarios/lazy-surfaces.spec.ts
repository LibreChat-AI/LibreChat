import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  replyPrompt,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { expect, test } from '../fixtures';

/** Surfaces a fresh chat never shows: they load when first opened or visited. */
const ON_DEMAND_CHUNK =
  /\/assets\/(Viewer|Search|ShareRoute|ResponseReviewRoute|Marketplace)\.[^/]+\.js$/;

function recordOnDemandChunks(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(ON_DEMAND_CHUNK);
    if (match) {
      seen.push(match[1]);
    }
  });
  return seen;
}

/** The mock fleet runs without the trace viewer, so the served config and availability turn it on. */
async function enableTraceViewer(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({
        response,
        json: {
          ...config,
          interface: { ...(config.interface ?? {}), traceViewer: { enabled: true } },
        },
      });
    },
  );
  await page.route(/\/api\/traces\/[^/]+\/availability$/, (route) =>
    route.fulfill({ json: { available: true } }),
  );
}

test.describe('surfaces that load on demand', () => {
  test('a fresh chat downloads none of the on-demand surfaces @scenario:fresh-chat-defers-on-demand-surfaces', async ({
    page,
  }) => {
    const seen = recordOnDemandChunks(page);
    /* The composer popovers load right after the chat renders; once they have, everything the
       fresh chat fetches on its own is in. */
    const popovers = page.waitForResponse((response) =>
      /\/assets\/PromptsCommand\.[^/]+\.js$/.test(new URL(response.url()).pathname),
    );
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await popovers;

    expect(seen).toEqual([]);
  });

  test('the search page loads its code on first visit @scenario:search-route-loads-on-visit', async ({
    page,
  }) => {
    const seen = recordOnDemandChunks(page);
    await page.goto('/search', { timeout: 15000 });

    await expect(page.getByText('Type to search your messages')).toBeVisible();
    expect(seen).toContain('Search');
  });

  test.describe('trace viewer', () => {
    test.use({ viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false });

    test('the trace shows a loading state, then the viewer, on first open @scenario:trace-viewer-loads-on-open', async ({
      page,
    }) => {
      await enableTraceViewer(page);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(/\/assets\/Viewer\.[^/]+\.js$/, async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await sendMessageAndWaitForCompletion(page, replyPrompt('trace'));

      await page.getByRole('button', { name: 'View trace' }).click();
      const loading = page.getByRole('status').filter({ hasText: 'Loading' });
      await expect(loading).toBeVisible();

      release();
      await expect(page.getByTestId('trace-viewer')).toBeVisible();
      await expect(loading).toBeHidden();
    });
  });
});
