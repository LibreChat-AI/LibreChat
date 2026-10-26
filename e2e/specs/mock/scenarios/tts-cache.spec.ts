import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { User } from '../../../types';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  replyPrompt,
  replyText,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { deleteConversations } from '../db';
import cleanupUser from '../../../setup/cleanupUser';

/**
 * Read-aloud audio is cached only in the tab's memory: a replay plays without a second TTS
 * request, nothing is written to Cache Storage, logout empties the cache, and the cache that
 * earlier versions persisted to disk is deleted when the app starts.
 */

test.describe.configure({ timeout: 120_000 });

/** The Cache Storage name earlier versions persisted audio under, keyed by message text. */
const LEGACY_TTS_CACHE = 'tts-responses';
const createdConversationIds: string[] = [];

test.afterAll(async () => {
  await deleteConversations(createdConversationIds);
});

/** Stands in for a configured external TTS provider: the e2e config has none. */
async function routeExternalSpeech(
  target: Page | BrowserContext,
): Promise<{ requests: () => number }> {
  let ttsRequests = 0;
  await target.route('**/api/files/speech/config/get', (route) =>
    route.fulfill({
      json: { textToSpeech: true, engineTTS: 'external', cacheTTS: true, ttsExternal: true },
    }),
  );
  await target.route('**/api/files/speech/tts/voices', (route) =>
    route.fulfill({ json: ['alloy'] }),
  );
  await target.route('**/api/files/speech/tts/manual', (route) => {
    ttsRequests += 1;
    return route.fulfill({
      body: Buffer.from([0xff, 0xf3, 0x00, 0x00]),
      contentType: 'audio/mpeg',
    });
  });
  return { requests: () => ttsRequests };
}

const useExternalEngine = (target: Page | BrowserContext) =>
  target.addInitScript(() => {
    localStorage.setItem('engineTTS', JSON.stringify('external'));
    localStorage.setItem('voice', JSON.stringify('alloy'));
  });

/** Sends a message to the mock model and returns the read-aloud button of its reply. */
async function replyToReadAloud(page: Page, prefix: string) {
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const label = `${prefix}-${randomUUID().slice(0, 8)}`;
  await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  await expect(page.getByText(replyText(label)).first()).toBeVisible({ timeout: 20000 });
  const conversationId = new URL(page.url()).pathname.split('/c/')[1];
  if (conversationId) createdConversationIds.push(conversationId);
  return page.getByRole('button', { name: 'Read aloud' }).last();
}

const cacheStorageNames = (page: Page) => page.evaluate(() => caches.keys());

test.describe('read-aloud audio cache', () => {
  test('replaying a message plays from memory without a second TTS request @scenario:tts-replay-served-from-memory', async ({
    page,
  }) => {
    await useExternalEngine(page);
    const speech = await routeExternalSpeech(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    const readAloud = await replyToReadAloud(page, 'tts');
    await readAloud.click();
    await expect.poll(() => speech.requests()).toBe(1);

    await expect(readAloud).toHaveAccessibleName('Read aloud');
    await readAloud.click();
    /** Give a second request time to start, if one were going to. */
    await page.waitForTimeout(1500);
    expect(speech.requests()).toBe(1);
  });

  test('read-aloud audio is never written to Cache Storage @scenario:tts-audio-never-persisted', async ({
    page,
  }) => {
    await useExternalEngine(page);
    const speech = await routeExternalSpeech(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    const readAloud = await replyToReadAloud(page, 'disk');
    await readAloud.click();
    await expect.poll(() => speech.requests()).toBe(1);
    await page.waitForTimeout(1000);

    expect(await cacheStorageNames(page)).not.toContain(LEGACY_TTS_CACHE);
    expect((await cacheStorageNames(page)).filter((name) => name.startsWith('tts'))).toEqual([]);
  });

  test('logging out empties the read-aloud cache @scenario:tts-memory-cleared-on-logout', async ({
    browser,
    baseURL,
  }) => {
    const { context, page, user } = await signInFreshUser(browser, baseURL);
    try {
      await useExternalEngine(context);
      const speech = await routeExternalSpeech(context);
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

      const readAloud = await replyToReadAloud(page, 'logout');
      const conversationPath = new URL(page.url()).pathname;
      await readAloud.click();
      await expect.poll(() => speech.requests()).toBe(1);

      /** Same tab, no reload: only the logout can have emptied the in-memory cache. The marker
       *  would be gone if the document had been replaced. */
      await page.evaluate(() => Object.assign(window, { ttsSameDocument: true }));
      await logOut(page);
      await logIn(page, user, /\/c\//);
      if (new URL(page.url()).pathname !== conversationPath) {
        await page.evaluate((path) => {
          window.history.pushState({}, '', path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, conversationPath);
      }
      await expect(page).toHaveURL(new RegExp(conversationPath));
      expect(await page.evaluate(() => 'ttsSameDocument' in window)).toBe(true);
      /** On a phone the sidebar drawer reopens over the conversation after signing in. */
      if ((page.viewportSize()?.width ?? 0) < 768) {
        const closeSidebar = page.getByTestId('close-sidebar-button');
        if (await closeSidebar.isVisible()) {
          await closeSidebar.click();
        }
      }
      await page.getByRole('button', { name: 'Read aloud' }).last().click();
      await expect.poll(() => speech.requests()).toBe(2);
    } finally {
      await context.close().catch(() => undefined);
      await cleanupUser(user);
    }
  });

  test('audio earlier versions saved to Cache Storage is deleted when the app starts @scenario:tts-legacy-disk-cache-purged-at-startup', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      await cache.put(
        '/E2E%20legacy%20reply%20text',
        new Response(new Blob([new Uint8Array([1])])),
      );
    }, LEGACY_TTS_CACHE);

    await page.reload();
    await expect
      .poll(() => page.evaluate((name) => caches.has(name), LEGACY_TTS_CACHE))
      .toBe(false);
  });
});

/** A dedicated account, so logging out does not end the session other specs share. */
async function signInFreshUser(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page; user: User }> {
  if (typeof baseURL !== 'string') {
    throw new Error('baseURL must be configured for mock scenarios');
  }
  const user: User = {
    name: 'TTS Cache',
    email: `tts-cache-${randomUUID().slice(0, 8)}@example.com`,
    password: `Pw-${randomUUID()}`,
  };
  await cleanupUser(user);
  const context = await browser.newContext({ storageState: undefined, baseURL });
  await context.addInitScript(() => {
    localStorage.setItem('navVisible', 'true');
    /** The shared storage state opts into sending with Enter; a fresh account has to as well. */
    localStorage.setItem('enterToSend', 'true');
  });
  const registered = await context.request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registered.ok()).toBeTruthy();

  const page = await context.newPage();
  await page.goto('/login', { timeout: 10000 });
  await logIn(page, user);
  return { context, page, user };
}

async function logIn(page: Page, user: User, landing = /\/c\/new/): Promise<void> {
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
  await page.waitForURL(landing, { timeout: 10000 });
}

async function logOut(page: Page): Promise<void> {
  /** The sidebar toggle is only meaningful once the app has rendered its chrome. */
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 20000,
  });
  const navUser = page.getByTestId('nav-user');
  if (!(await navUser.isVisible())) {
    await page.getByTestId('header-open-sidebar-button').click();
  }
  await navUser.click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await page.waitForURL(/\/login/, { timeout: 10000 });
}
