import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { expect, test } from '../fixtures';

/** Chunks that only math, code highlighting, the query devtools or an opened side panel need. */
const LAZY_CHUNK =
  /\/assets\/(math-katex|markdown_highlight|query-devtools|AgentPanelSwitch|MemoryPanel|SchedulePanel|MCPBuilderPanel|BookmarkPanel|PanelSwitch)\.[^/]+\.(?:js|css)$/;

function recordLazyChunks(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(LAZY_CHUNK);
    if (match) {
      seen.push(match[1]);
    }
  });
  return seen;
}

async function openChat(page: Page): Promise<void> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
}

test.describe('code loaded on first need', () => {
  test('a plain conversation loads no math, highlighting or panel code @scenario:plain-chat-loads-no-lazy-chunks', async ({
    page,
  }) => {
    const seen = recordLazyChunks(page);
    await openChat(page);
    await sendMessageAndWaitForCompletion(page, replyPrompt('plain'));
    await expect(messagesView(page).getByText(replyText('plain'))).toBeVisible();

    expect(seen).toEqual([]);
  });

  test('fenced code in a reply is highlighted once highlighting loads @scenario:code-reply-is-highlighted', async ({
    page,
  }) => {
    const seen = recordLazyChunks(page);
    await openChat(page);
    await sendMessageAndWaitForCompletion(page, 'E2E_MARKDOWN_REPLY');

    const code = messagesView(page).locator('code', { hasText: 'e2eSyntaxHighlight' });
    await expect(code.locator('[class*="hljs-"]').first()).toBeVisible();
    expect(seen).toContain('markdown_highlight');
  });

  test('math in a reply renders with KaTeX once it loads @scenario:math-reply-renders-with-katex', async ({
    page,
  }) => {
    await openChat(page);
    await sendMessageAndWaitForCompletion(page, 'E2E_MATH_REPLY');

    /* Both formulas render, the inline one through mhchem, which registers in the same chunk. */
    const formulas = messagesView(page).locator('.katex');
    await expect(formulas).toHaveCount(2);
    await expect(formulas.first()).toBeVisible();
    /* The stylesheet arrives with the chunk; without it KaTeX output falls back to body type. */
    expect(await formulas.first().evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(
      /KaTeX/,
    );
  });
});

test.describe('side panel tabs', () => {
  test.use({ viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false });

  test('a panel shows a loading state, then its content, on first open @scenario:side-panel-tab-loads-on-open', async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/assets\/AgentPanelSwitch\.[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

    await page.getByRole('button', { name: 'Agent Builder' }).first().click();
    const loading = page.getByRole('status').filter({ hasText: 'Loading' });
    await expect(loading).toBeVisible();

    release();
    await expect(loading).toBeHidden();
    await expect(page.getByPlaceholder('Agent name')).toBeVisible();
  });
});
