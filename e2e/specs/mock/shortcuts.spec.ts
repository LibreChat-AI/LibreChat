import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  isAgentsStream,
  messagesView,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

const messageTurns = (page: Page) => messagesView(page).locator('.message-render');
const navRail = (page: Page) => page.getByRole('navigation', { name: 'Message navigation' });

/** Persist a custom shortcut binding before the app boots, so the dispatcher
 *  resolves it at init exactly like a user-saved rebinding. */
async function rebindShortcut(page: Page, actionId: string, chord: string) {
  await page.addInitScript(
    ([id, value]) => {
      window.localStorage.setItem(
        'customKeyboardShortcuts',
        JSON.stringify({ [id]: { mac: value, other: value } }),
      );
    },
    [actionId, chord],
  );
}

async function establishTurn(page: Page, label: string) {
  const response = await sendMessage(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });
}

/** Sending leaves the composer focused, where the dispatcher's editing gate
 *  swallows non-editing shortcuts before the yield contract is even reached.
 *  Both rail presses must happen with focus outside any input. */
async function blurComposer(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/**
 * Real-browser regression net for the global shortcut dispatcher's yield
 * contract (PR: honor `defaultPrevented`, window-level listener): a keypress
 * claimed by a closer handler must not ALSO trigger a global action, while an
 * unclaimed keypress still must. The jest suite proves the dispatcher logic
 * against synthetic DOM; these two flows wire the REAL owners (the message-nav
 * rail's document-level listener and the composer's keydown verdicts) through
 * real Chromium event propagation.
 */
test.describe('global shortcut yield contract', () => {
  test('a rebound chord fires globally until the message-nav rail claims it', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('nav-claim');

    // Bind "New chat" onto the rail's own chord so both want the keypress.
    await rebindShortcut(page, 'newChat', 'Alt+Shift+M');
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    // One turn: the rail needs 3+ entries, so it is NOT rendered yet and the
    // chord is unclaimed. The global action must fire — this also proves the
    // rebinding is live in this browser, so the claim assertion below cannot
    // pass vacuously.
    await establishTurn(page, `${label}-a`);
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
    await expect(navRail(page)).toHaveCount(0);
    await blurComposer(page);
    await page.keyboard.press('Alt+Shift+M');
    await expect(page).toHaveURL(/\/c\/new$/, { timeout: 10000 });

    // Two turns in the fresh chat: the rail renders and now owns the chord.
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await establishTurn(page, `${label}-b`);
    await expect(page).toHaveURL(/\/c\/[0-9a-fA-F-]{36}$/, { timeout: 15000 });
    await establishTurn(page, `${label}-c`);
    await expect(navRail(page)).toBeVisible({ timeout: 10000 });
    const conversationUrl = page.url();

    // The rail claims the keypress (focuses an entry + preventDefault); the
    // rebound global action must yield: focus moves into the rail and the
    // URL never flips back to /c/new.
    await blurComposer(page);
    await page.keyboard.press('Alt+Shift+M');
    await expect(page.locator(':focus')).toHaveAttribute('data-msg-id', /.+/, { timeout: 5000 });
    await expect(page).toHaveURL(conversationUrl);
  });

  test('a custom submit chord in the composer submits exactly once', async ({ page }) => {
    test.setTimeout(120000);
    const label = uniqueLabel('single-submit');
    const prompt = replyPrompt(label);

    // Rebind submit to Alt+Enter: the composer resolves the chord itself
    // (claims the keypress), and the dispatcher's submitMessage action must
    // yield instead of clicking send again — a regression here double-sends
    // the same message.
    await rebindShortcut(page, 'submitMessage', 'Alt+Enter');
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    // The generation POST goes to /api/agents/chat/<endpoint>; collect every
    // agents-chat POST path so a duplicate submit (same path, fired again)
    // cannot hide, whatever the endpoint suffix is.
    const agentPosts: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && pathname.startsWith('/api/agents/chat')) {
        agentPosts.push(pathname);
      }
    });

    const input = page.getByRole('textbox', { name: 'Message input' });
    await input.click();
    await input.fill(prompt);
    const [response] = await Promise.all([
      page.waitForResponse(isAgentsStream, { timeout: 30000 }),
      input.press('Alt+Enter'),
    ]);
    expect(response.ok()).toBeTruthy();
    const generationPath = new URL(response.url()).pathname;
    await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 30000 });

    // Settle briefly so a late duplicate submission would surface, then
    // assert the single-fire invariant at both layers: one generation
    // request on the wire, one user turn + one reply in the thread.
    await page.waitForTimeout(750);
    expect(agentPosts.filter((pathname) => pathname === generationPath)).toHaveLength(1);
    await expect(messageTurns(page)).toHaveCount(2);
    await expect(messagesView(page).getByText(prompt)).toHaveCount(1);
  });
});
