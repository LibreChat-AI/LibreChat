import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { parseSessionHint, formatSessionHint, SESSION_HINT_COOKIE } from 'librechat-data-provider';
import type { SessionHint, ThemeDefinition } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import {
  readBundledThemeBoot,
  injectDeploymentThemeBoot,
} from '../../../../packages/api/src/html/theme';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { resolveTheme } from '../../../../packages/data-provider/src/themes/registry';

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

type Mode = 'light' | 'dark';

/** An operator's own `interface.theme`, written inline in librechat.yaml rather than named. */
const inlineTheme = {
  version: 1 as const,
  name: 'acme',
  modes: {
    light: {
      colors: {
        'rgb-surface-primary': '250 238 220',
        'rgb-surface-primary-alt': '244 228 204',
        'rgb-surface-canvas': '252 244 232',
      },
    },
    dark: {
      colors: {
        'rgb-surface-primary': '28 36 52',
        'rgb-surface-primary-alt': '20 26 40',
        'rgb-surface-canvas': '16 22 34',
      },
    },
  },
} satisfies ThemeDefinition;

type ThemeSource = 'clickhouse' | typeof inlineTheme;

type Frame = {
  at: number;
  theme: string | null;
  surface: string;
  shell: string | null;
  /** The bundle has replaced the loading shell with the app. */
  app: boolean;
};

declare global {
  interface Window {
    __themeFrames?: Frame[];
  }
}

const APP_PAINT_TIMEOUT_MS = 45000;
const CACHE_KEY = 'deployment-theme';

/**
 * Serves `theme` as `interface.theme` (`null` removes it), holding the answer until the
 * app has painted while `held()`. Returns when each signed-in answer was sent: that
 * answer is the one carrying the signed-in theme, so the frames before it are the ones
 * under test. Without `signedInOnly`, every answer counts, signed out ones included.
 */
async function serveTheme(
  page: Page,
  theme: () => ThemeSource | null,
  held: () => boolean,
  signedInOnly = true,
) {
  const answeredAt: number[] = [];
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const served = { ...body.interface };
      delete served.theme;
      const value = theme();
      if (value !== null) {
        served.theme = value;
      }
      if (held()) {
        await page
          .waitForFunction(() => window.__themeFrames?.some((frame) => frame.app), undefined, {
            timeout: APP_PAINT_TIMEOUT_MS,
          })
          .catch(() => undefined);
      }
      if (!signedInOnly || route.request().headers()['authorization']) {
        answeredAt.push(Date.now());
      }
      await route.fulfill({ response, json: { ...body, interface: served } });
    },
  );
  return answeredAt;
}

/** Records every frame from the first one the document can paint. */
async function sampleFrames(page: Page) {
  await page.addInitScript(() => {
    window.__themeFrames = [];
    const sample = () => {
      if (document.body) {
        const root = document.documentElement;
        const shell = document.getElementById('loading-container');
        window.__themeFrames?.push({
          at: performance.timeOrigin + performance.now(),
          theme: root.getAttribute('data-theme'),
          surface: getComputedStyle(root).getPropertyValue('--surface-primary').trim(),
          shell: shell ? getComputedStyle(shell).backgroundColor : null,
          app: !shell && (document.getElementById('root')?.childElementCount ?? 0) > 0,
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function throttle(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 400,
    downloadThroughput: (1.5 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

/**
 * Frames sampled before the signed-in answer, checked to cover both surfaces: the first
 * frame showing content is the loading shell (a frame sampled before `#root` is parsed
 * shows neither), and the app painted too.
 */
async function framesBeforeAnswer(page: Page, answeredAt: number[], reloadedAt: number) {
  await expect.poll(() => answeredAt.some((at) => at > reloadedAt)).toBe(true);
  const answered = Math.min(...answeredAt.filter((at) => at > reloadedAt));
  const frames = (await page.evaluate(() => window.__themeFrames ?? [])).filter(
    (frame) => frame.at < answered,
  );
  expect(frames.find((frame) => frame.shell !== null || frame.app)?.shell).toBeTruthy();
  expect(frames.some((frame) => frame.app)).toBe(true);
  return frames;
}

async function openChat(page: Page) {
  await page.goto('/c/new');
  await expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 30000 });
}

/** The session expiry the server mirrors in a page-readable cookie, in epoch milliseconds. */
async function sessionHint(page: Page): Promise<SessionHint | undefined> {
  const value = await page.evaluate(
    (name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie)?.[1],
    SESSION_HINT_COOKIE,
  );
  return value ? parseSessionHint(decodeURIComponent(value)) : undefined;
}

/** Rewrites the page-readable session hint as `change` says, leaving the session cookies alone. */
async function rewriteSessionHint(page: Page, change: (hint: SessionHint) => SessionHint) {
  const hint = await sessionHint(page);
  expect(hint).toBeDefined();
  const value = encodeURIComponent(formatSessionHint(change(hint as SessionHint)));
  await page.evaluate(
    ([name, rewritten]) => {
      document.cookie = `${name}=${rewritten}; path=/`;
    },
    [SESSION_HINT_COOKIE, value],
  );
}

const rgb = (channels?: string) => `rgb(${(channels ?? '').split(' ').join(', ')})`;

/** Reloads throttled with the config held, and checks every frame before the answer. */
async function expectFirstPaint(page: Page, mode: Mode) {
  let held = false;
  const answeredAt = await serveTheme(
    page,
    () => 'clickhouse',
    () => held,
  );
  const { colors } = resolveTheme(clickHouseTheme, mode);

  await openChat(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), CACHE_KEY))
    .not.toBeNull();
  /** The reload happens inside a live session of the identity the cache belongs to. */
  const hint = await sessionHint(page);
  expect(hint?.expires).toBeGreaterThan(Date.now());
  expect(hint?.owner).toBe(
    await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null')?.owner, CACHE_KEY),
  );

  await sampleFrames(page);
  await throttle(page);
  held = true;
  const reloadedAt = Date.now();
  await page.reload();
  await expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 60000 });
  const frames = await framesBeforeAnswer(page, answeredAt, reloadedAt);

  for (const frame of frames) {
    expect(frame.theme).toBe('clickhouse');
    expect(frame.surface).toBe(colors['rgb-surface-primary']);
    if (frame.shell !== null) {
      expect(frame.shell).toBe(rgb(colors['rgb-surface-canvas']));
    }
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-boot');
}

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
  let theme: string | null = 'clickhouse';
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

/**
 * A first-ever visit has nothing cached, so the server embeds the deployment's base
 * `interface.theme` in the shell it serves (`createDeploymentThemeShell`). The mock lane's
 * yaml sets no theme, so each document is fetched from the server and passed through the same
 * injection, with the `theme-boot.json` this build emitted, as a server configured with
 * `interface.theme: clickhouse` serves it.
 */
async function serveThemedShell(page: Page, source: ThemeSource) {
  const bundled = readBundledThemeBoot(resolve(__dirname, '../../../../client/dist'));
  expect(bundled.clickhouse).toBeDefined();
  await page.route(
    () => true,
    async (route) => {
      if (route.request().resourceType() !== 'document') {
        return route.fallback();
      }
      const response = await route.fetch();
      const html = injectDeploymentThemeBoot(await response.text(), source, bundled);
      await route.fulfill({ response, body: html });
    },
  );
}

/** Every `/api/config` answer, signed in or not, held until the app paints: the first one ends the window under test. */
function holdConfig(page: Page, source: ThemeSource) {
  return serveTheme(
    page,
    () => source,
    () => true,
    false,
  );
}

/** Opens `path` in a browser that has never cached a deployment theme, throttled, and returns the frames before the config answers. */
async function firstVisitFrames(
  page: Page,
  path: string,
  ready: () => Promise<void>,
  source: ThemeSource = 'clickhouse',
) {
  await page.addInitScript((key) => {
    localStorage.removeItem(key);
    sessionStorage.clear();
  }, CACHE_KEY);
  await serveThemedShell(page, source);
  const answeredAt = await holdConfig(page, source);
  await sampleFrames(page);
  await throttle(page);
  await page.goto(path);
  await ready();
  await expect.poll(() => answeredAt.length).toBeGreaterThan(0);

  const answered = Math.min(...answeredAt);
  return (await page.evaluate(() => window.__themeFrames ?? [])).filter(
    (frame) => frame.at < answered,
  );
}

/** A signed-in first visit: every frame before the answer, shell and app alike, wears the theme. */
async function expectFirstVisit(page: Page, mode: Mode, source: ThemeSource = 'clickhouse') {
  const definition = typeof source === 'string' ? clickHouseTheme : source;
  const { colors } = resolveTheme(definition, mode);
  const frames = await firstVisitFrames(
    page,
    '/c/new',
    () => expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 60000 }),
    source,
  );

  /** Frames of both the shell and the first render landed before the answer. */
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0].shell).not.toBeNull();
  expect(frames.some((frame) => frame.app)).toBe(true);
  for (const frame of frames) {
    expect(frame.theme).toBe(definition.name);
    expect(frame.surface).toBe(colors['rgb-surface-primary']);
    if (frame.shell !== null) {
      expect(frame.shell).toBe(rgb(colors['rgb-surface-canvas']));
    }
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', definition.name);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme-boot');
}

/** A signed-out first visit to the login page, which is where a new browser lands. */
async function expectFirstVisitLogin(page: Page, mode: Mode) {
  const { colors } = resolveTheme(clickHouseTheme, mode);
  const frames = await firstVisitFrames(page, '/login', () =>
    expect(page.getByTestId('login-button')).toBeVisible({ timeout: 60000 }),
  );

  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0].shell).not.toBeNull();
  for (const frame of frames) {
    expect(frame.theme).toBe('clickhouse');
    expect(frame.surface).toBe(colors['rgb-surface-primary']);
    if (frame.shell !== null) {
      expect(frame.shell).toBe(rgb(colors['rgb-surface-primary-alt']));
    }
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
}

test.describe('deployment theme first-ever visit (light)', () => {
  test.use({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });

  test('a first-ever signed-in visit paints the operator theme from the first frame in light @scenario:deployment-theme-first-visit-light', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectFirstVisit(page, 'light');
  });

  test('a first-ever signed-in visit paints an inline operator theme from the first frame in light @scenario:deployment-theme-first-visit-inline-light', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectFirstVisit(page, 'light', inlineTheme);
  });

  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('a first-ever visit to the login page paints the operator theme from the first frame in light @scenario:deployment-theme-first-visit-login-light', async ({
      page,
    }) => {
      test.setTimeout(120000);
      await expectFirstVisitLogin(page, 'light');
    });
  });
});

test.describe('deployment theme first-ever visit (dark)', () => {
  test.use({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } });

  test('a first-ever signed-in visit paints the operator theme from the first frame in dark @scenario:deployment-theme-first-visit-dark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectFirstVisit(page, 'dark');
  });

  test('a first-ever signed-in visit paints an inline operator theme from the first frame in dark @scenario:deployment-theme-first-visit-inline-dark', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await expectFirstVisit(page, 'dark', inlineTheme);
  });

  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('a first-ever visit to the login page paints the operator theme from the first frame in dark @scenario:deployment-theme-first-visit-login-dark', async ({
      page,
    }) => {
      test.setTimeout(120000);
      await expectFirstVisitLogin(page, 'dark');
    });
  });
});
