import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import type { ThemeSource } from './deployment-theme.helpers';
import {
  CACHE_KEY,
  serveTheme,
  sampleFrames,
  throttle,
  framesBeforeAnswer,
  openChat,
  sessionHint,
  rewriteSessionHint,
  expectFirstPaint,
} from './deployment-theme.helpers';

/**
 * `interface.theme` exists only in the `/api/config` answer, so before this
 * change a signed-in reload painted the chat in the default palette until that
 * answer arrived. The reload now replays the last served deployment theme from
 * the inline boot script in `client/index.html` and from `DeploymentTheme`'s
 * cache, so every frame before the answer already wears it.
 *
 * The reload runs throttled (400 ms latency, 1.5 Mbps, 4x CPU) and the config
 * answer is held until the rendered app has painted (the chat layout paints
 * before the config answers; the composer waits for it), so frames of both the
 * loading shell and the app land before it. A fixed hold is not enough: under
 * load the throttled main thread can paint no frame at all for longer than it.
 * Every frame is sampled in a `requestAnimationFrame` callback, which runs
 * before the frame paints.
 */

// Use full Chromium locally, matching CI's Chrome, without trace or video capture
// competing with protocol calls under CPU throttling. Failure screenshots remain enabled.
test.use({ channel: process.env.E2E_CHROMIUM_CHANNEL ?? 'chromium', trace: 'off', video: 'off' });

test.describe('deployment theme first paint (light)', () => {
  test.use({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });

  test('a signed-in reload paints the cached deployment theme from the first frame in light @scenario:deployment-theme-first-paint-light', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectFirstPaint(page, 'light');
  });
});

test.describe('deployment theme first paint (dark)', () => {
  test.use({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } });

  test('a signed-in reload paints the cached deployment theme from the first frame in dark @scenario:deployment-theme-first-paint-dark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectFirstPaint(page, 'dark');
  });
});

test('a deployment theme removed since the last visit wins once the config answers @scenario:deployment-theme-removed-wins-over-cache', async ({
  page,
}) => {
  test.setTimeout(90000);
  let theme: ThemeSource | null = 'clickhouse';
  await serveTheme(
    page,
    () => theme,
    () => false,
  );

  await openChat(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), CACHE_KEY))
    .not.toBeNull();

  theme = null;
  await page.reload();
  await expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'clickhouse');
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), CACHE_KEY)).toBeNull();
});

/**
 * The session cookies are unreadable before the bundle runs, so the cache is replayed only
 * in a tab that last saw its owner signed in. A cache left by another identity, or a tab
 * with no signed-in owner yet, paints the default shell until the config answers. The
 * signed-out answer counts: it carries the deployment theme too, and with no cache replayed
 * it is the first source the app may paint it from.
 */
async function expectNoCachedPaint(page: Page, open: (page: Page) => Promise<void>) {
  let held = false;
  const answeredAt = await serveTheme(
    page,
    () => 'clickhouse',
    () => held,
    false,
  );
  await openChat(page);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), CACHE_KEY))
    .not.toBeNull();

  await open(page);
  await sampleFrames(page);
  await throttle(page);
  held = true;
  const reloadedAt = Date.now();
  await page.reload();
  await expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 60000 });
  const frames = await framesBeforeAnswer(page, answeredAt, reloadedAt);
  for (const frame of frames) {
    expect(frame.theme).toBeNull();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
  await expect
    .poll(() =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.owner, CACHE_KEY),
    )
    .not.toBe('tenant-x:someone-else');
}

/** What a browser that last held another identity's theme carries into this tab. */
const cacheForSomeoneElse = (page: Page) =>
  page.evaluate((key) => {
    const entry = JSON.parse(localStorage.getItem(key) ?? 'null');
    localStorage.setItem(key, JSON.stringify({ ...entry, owner: 'tenant-x:someone-else' }));
  }, CACHE_KEY);

/** A fresh tab: the session cookies are shared, the tab's own session storage is not. */
const forgetTabOwner = (page: Page) => page.evaluate(() => sessionStorage.clear());

/** A tab that outlived its session: the owner marker and the cache still match, the hint has expired. */
/**
 * A reload of a tab whose session ended. The refresh is refused the way the server refuses an
 * expired session, so the app lands on the login page, and the signed-out config answers with
 * the deployment theme too: no frame before the first answer of any kind may wear the cached
 * theme, and the session end drops the cache and the tab owner.
 */
async function expectEndedSessionPaint(page: Page, open: (page: Page) => Promise<void>) {
  let held = false;
  const answeredAt = await serveTheme(
    page,
    () => 'clickhouse',
    () => held,
    false,
  );
  await openChat(page);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), CACHE_KEY))
    .not.toBeNull();

  await open(page);
  await page.route(
    (url) => url.pathname === '/api/auth/refresh',
    (route) =>
      route.fulfill({ status: 401, body: 'Refresh token expired or not found for this user' }),
  );
  await sampleFrames(page);
  await throttle(page);
  held = true;
  const reloadedAt = Date.now();
  await page.reload();
  await expect(page).toHaveURL(/\/login/, { timeout: 60000 });
  const frames = await framesBeforeAnswer(page, answeredAt, reloadedAt);
  for (const frame of frames) {
    expect(frame.theme).toBeNull();
  }
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), CACHE_KEY)).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('deployment-theme-owner'))).toBeNull();
}

const endSession = (page: Page) =>
  rewriteSessionHint(page, (hint) => ({ ...hint, expires: Date.now() - 1000 }));

/**
 * Another identity's session, signed in since through a flow that ends in a full navigation
 * (an OAuth callback): the tab's owner marker and the cache still name the previous identity.
 */
const otherSession = (page: Page) =>
  rewriteSessionHint(page, (hint) => ({ ...hint, owner: 'tenant-x:someone-else' }));

test.describe('cached theme owner (light)', () => {
  test.use({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });

  test('a reload paints no deployment theme cached for another identity in light @scenario:cached-theme-other-owner-not-boot-painted-light', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectNoCachedPaint(page, cacheForSomeoneElse);
  });

  test('a tab that has not seen its owner signed in paints no cached deployment theme in light @scenario:cached-theme-unknown-owner-not-boot-painted-light', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectNoCachedPaint(page, forgetTabOwner);
  });

  test('a tab whose session has ended paints no cached deployment theme in light @scenario:cached-theme-expired-session-not-boot-painted-light', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectEndedSessionPaint(page, endSession);
  });

  test('a tab now signed in as someone else paints no cached deployment theme in light @scenario:cached-theme-other-session-not-boot-painted-light', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectEndedSessionPaint(page, otherSession);
  });
});

test.describe('cached theme owner (dark)', () => {
  test.use({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } });

  test('a reload paints no deployment theme cached for another identity in dark @scenario:cached-theme-other-owner-not-boot-painted-dark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectNoCachedPaint(page, cacheForSomeoneElse);
  });

  test('a tab that has not seen its owner signed in paints no cached deployment theme in dark @scenario:cached-theme-unknown-owner-not-boot-painted-dark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectNoCachedPaint(page, forgetTabOwner);
  });

  test('a tab whose session has ended paints no cached deployment theme in dark @scenario:cached-theme-expired-session-not-boot-painted-dark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectEndedSessionPaint(page, endSession);
  });

  test('a tab now signed in as someone else paints no cached deployment theme in dark @scenario:cached-theme-other-session-not-boot-painted-dark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectEndedSessionPaint(page, otherSession);
  });
});

test('a session refresh keeps the readable session hint on the refresh session expiry and owner @scenario:session-refresh-keeps-hint-aligned', async ({
  page,
}) => {
  await openChat(page);
  const before = await sessionHint(page);
  expect(before?.expires).toBeGreaterThan(Date.now());

  const refreshed = await page.evaluate(async () => {
    const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    return response.ok;
  });
  expect(refreshed).toBe(true);

  const after = await sessionHint(page);
  const refreshCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === 'refreshToken',
  );
  expect(after?.owner).toBe(before?.owner);
  expect(after?.expires).toBeGreaterThanOrEqual(before?.expires ?? Number.POSITIVE_INFINITY);
  expect(Math.floor((after?.expires ?? 0) / 1000)).toBe(Math.floor(refreshCookie?.expires ?? -1));
});
