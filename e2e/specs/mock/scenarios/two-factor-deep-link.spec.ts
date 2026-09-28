import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * An ordinary (already enrolled) 2FA sign-in parks its destination in session storage when the
 * login screen mounts, swaps the document to `/` once the challenge is verified, and rebuilds
 * the session through the silent refresh. The destination has to survive that document swap and
 * be consumed by the sign-in that carried it, and the sign-in itself must never depend on the
 * store being writable at all.
 */

/** A non-default destination: reaching it proves the deep link outlived the whole challenge.
 *  The marker rides the query so no conversation has to exist for the landing to hold. */
const DEEP_LINK = '/c/new?model=test&deep-link=proof';
const DEEP_LINK_PATTERN = /\/c\/new\?model=test&deep-link=proof$/;
/** The second sign-in's own destination: distinct from the first's on purpose. */
const SECOND_LINK = '/c/new?from=second-signin';
const SECOND_LINK_PATTERN = /\/c\/new\?from=second-signin$/;
const DEFAULT_PATTERN = /\/c\/new$/;
const CHALLENGE_PATTERN = /\/login\/2fa\?tempToken=temp-token$/;

const ENROLLED_USER = {
  id: 'user-2fa',
  _id: 'user-2fa',
  name: 'Two Factor User',
  username: 'twofactor',
  email: 'twofactor@example.com',
  provider: 'local',
  role: 'USER',
  emailVerified: true,
  twoFactorEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** The PWA service worker serves API GETs itself, which would bypass every `page.route` below. */
test.use({ storageState: { cookies: [], origins: [] }, serviceWorkers: 'block' });

/**
 * The auth endpoints are intercepted so the ordinary challenge answers deterministically: login
 * always demands the temp-token challenge, and the refresh endpoint speaks for the cookie the
 * real verify controller sets — dead before verification, live after it, dead again on logout.
 */
async function mockChallengeAuth(page: Page) {
  let sessionLive = false;

  /** Registered first, so every specific mock below takes precedence. The shell's
   *  authenticated queries are answered with their empty shapes: letting them 401 against
   *  the real backend (the bearer is a stand-in for the cookie the real verify controller
   *  sets) would spin the auth-recovery interceptor, whose login bounce carries the current
   *  URL as redirect_to — re-declaring a destination mid-test and re-persisting it at the
   *  login screen. Only /api/config stays real: the login screen renders from it. */
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (route.request().method() !== 'GET') {
      await json(route, {});
      return;
    }
    if (/\/api\/config(\?|$)/.test(url)) {
      const response = await route.fetch();
      await route.fulfill({ response });
      return;
    }
    if (url.includes('/api/endpoints')) {
      await json(route, []);
      return;
    }
    if (url.includes('/api/agents/chat/active')) {
      await json(route, []);
      return;
    }
    if (url.includes('/api/presets')) {
      await json(route, []);
      return;
    }
    if (/\/api\/tags(\?|$)/.test(url)) {
      await json(route, []);
      return;
    }
    if (url.includes('/api/models')) {
      await json(route, {});
      return;
    }
    if (url.includes('/api/convos?')) {
      await json(route, { conversations: [], pageInfo: { hasMore: false, page: 1, size: 0 } });
      return;
    }
    if (url.includes('/api/convos?pinned')) {
      await json(route, { conversations: [], pageInfo: { hasMore: false, page: 1, size: 0 } });
      return;
    }
    if (url.includes('/api/projects')) {
      await json(route, { projects: [], hasMore: false });
      return;
    }
    if (url.includes('/api/user/settings/')) {
      await json(route, []);
      return;
    }
    if (url.includes('/api/search/enable')) {
      await json(route, false);
      return;
    }
    if (url.includes('/api/balance')) {
      await json(route, {});
      return;
    }
    if (url.includes('/api/banner')) {
      await json(route, { banner: '' });
      return;
    }
    if (url.includes('/api/files/speech')) {
      await json(route, { enabled: false });
      return;
    }
    if (url.includes('/api/files')) {
      await json(route, []);
      return;
    }
    await json(route, {});
  });
  await page.route('**/api/auth/login', (route) =>
    json(route, { twoFAPending: true, tempToken: 'temp-token' }),
  );
  await page.route('**/api/auth/refresh', async (route) => {
    if (!sessionLive) {
      /** The shape the server really sends when no refresh cookie is presented. */
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: 'Refresh token not provided',
      });
      return;
    }
    await json(route, { token: 'auth-token', user: ENROLLED_USER });
  });
  await page.route('**/api/auth/2fa/verify-temp', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ tempToken: 'temp-token', token: '123456' });
    sessionLive = true;
    await json(route, { token: 'auth-token', user: ENROLLED_USER });
  });
  await page.route('**/api/auth/logout', async (route) => {
    sessionLive = false;
    await json(route, {});
  });
  await page.route('**/api/user', (route) =>
    sessionLive ? json(route, ENROLLED_USER) : json(route, { message: 'Unauthorized' }, 401),
  );
  await page.route('**/api/roles/**', (route) => json(route, { name: 'USER', permissions: {} }));
}

/** Drives one full ordinary-challenge sign-in from the login screen. The password field
 *  is located by label: SecretInput renders input[type=password], whose role mapping is
 *  not something the spec should depend on. */
async function signInThroughChallenge(page: Page) {
  await page.getByRole('textbox', { name: 'Email' }).fill(ENROLLED_USER.email);
  await page.getByLabel('Password').fill('password');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(CHALLENGE_PATTERN);
  await page.getByLabel('Enter your 2FA code to continue').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
}

/** The authenticated shell shows its account button on wide viewports and its header
 *  toggle on narrow ones; either mounting proves the sign-in completed and stayed. */
async function expectAuthenticatedShell(page: Page) {
  await expect
    .poll(
      async () =>
        (await page.getByTestId('nav-user').isVisible()) ||
        (await page.getByTestId('header-open-sidebar-button').isVisible()),
      { timeout: 30000 },
    )
    .toBe(true);
}

/** Ends the stand-in session the way the app itself would: an in-page logout request
 *  (page.request would bypass the route mocks) flips the session, and the next document
 *  load finds no session and keeps the login screen. */
async function endMockSession(page: Page) {
  await page.evaluate(() =>
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined),
  );
}

test.describe('ordinary 2FA challenge · deep links', () => {
  test('a safe destination survives the challenge and is consumed by that sign-in @scenario:2fa-deep-link-survives-challenge', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await mockChallengeAuth(page);

    await page.goto(`/login?redirect_to=${encodeURIComponent(DEEP_LINK)}`);
    await signInThroughChallenge(page);

    await expect(page).toHaveURL(DEEP_LINK_PATTERN, { timeout: 15000 });
    /** The authenticated shell mounts and settles here rather than bouncing back to /login. */
    await expectAuthenticatedShell(page);
    /** Consumed by that sign-in: nothing is left to misdirect a later one. */
    expect(await page.evaluate(() => sessionStorage.getItem('post_login_redirect_to'))).toBeNull();

    /** A fixed window is the point: the destination must survive the follow-up auth traffic. */
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(DEEP_LINK_PATTERN);

    /** A reload authenticates through the refreshed session and stays on the deep link. */
    await page.reload();
    await expectAuthenticatedShell(page);
    await expect(page).toHaveURL(DEEP_LINK_PATTERN);
  });

  test('the sign-in completes when session storage is blocked @scenario:2fa-signin-completes-when-storage-blocked', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await mockChallengeAuth(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        /** Configurable because the CI-mode build's storage polyfill replaces a broken
         *  sessionStorage with its own in-memory shim rather than crashing on a frozen
         *  property. The shim is per-document, so the challenge's document swap still
         *  empties it and the landing contract is identical either way. */
        configurable: true,
        get() {
          throw new DOMException('Storage is blocked in this context', 'SecurityError');
        },
      });
    });

    await page.goto(`/login?redirect_to=${encodeURIComponent(DEEP_LINK)}`);
    /** The store being unwritable must cost the destination, never the sign-in itself. */
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible({ timeout: 15000 });
    await signInThroughChallenge(page);

    await expectAuthenticatedShell(page);
    await expect(page).toHaveURL(DEFAULT_PATTERN);
  });

  test('a consumed destination does not misdirect the next sign-in in the tab @scenario:2fa-destination-consumed-once-across-signins', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await mockChallengeAuth(page);

    await page.goto(`/login?redirect_to=${encodeURIComponent(DEEP_LINK)}`);
    await signInThroughChallenge(page);
    await expect(page).toHaveURL(DEEP_LINK_PATTERN, { timeout: 15000 });
    await expectAuthenticatedShell(page);

    await endMockSession(page);

    /** The second sign-in declares a destination of its own: it must land there,
     *  not on the first sign-in's, and leave nothing behind for a third. */
    await page.goto(`/login?redirect_to=${encodeURIComponent(SECOND_LINK)}`);
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible({ timeout: 15000 });
    await signInThroughChallenge(page);
    await expect(page).toHaveURL(SECOND_LINK_PATTERN, { timeout: 15000 });
    await expectAuthenticatedShell(page);
    expect(await page.evaluate(() => sessionStorage.getItem('post_login_redirect_to'))).toBeNull();
  });
});
