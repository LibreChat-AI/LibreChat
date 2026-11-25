import { parseSessionHint, formatSessionHint, SESSION_HINT_COOKIE } from 'librechat-data-provider';
import type { SessionHint, ThemeDefinition } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { resolveTheme } from '../../../../packages/data-provider/src/themes/registry';
import { expect, test } from '../fixtures';

export type Mode = 'light' | 'dark';

/** An operator's own `interface.theme`, written inline in librechat.yaml rather than named. */
export const inlineTheme = {
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

export type ThemeSource = 'clickhouse' | typeof inlineTheme;

export type Frame = {
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

export const APP_PAINT_TIMEOUT_MS = 45000;
export const CACHE_KEY = 'deployment-theme';

/**
 * Serves `theme` as `interface.theme` (`null` removes it), holding the answer until the
 * app has painted while `held()`. Returns when each signed-in answer was sent: that
 * answer is the one carrying the signed-in theme, so the frames before it are the ones
 * under test. Without `signedInOnly`, every answer counts, signed out ones included.
 */
export async function serveTheme(
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
export async function sampleFrames(page: Page) {
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

export async function throttle(page: Page) {
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
export async function framesBeforeAnswer(page: Page, answeredAt: number[], reloadedAt: number) {
  await expect.poll(() => answeredAt.some((at) => at > reloadedAt)).toBe(true);
  const answered = Math.min(...answeredAt.filter((at) => at > reloadedAt));
  const frames = (await page.evaluate(() => window.__themeFrames ?? [])).filter(
    (frame) => frame.at < answered,
  );
  await test.info().attach('cached-theme-frames', {
    body: Buffer.from(JSON.stringify(frames, null, 2)),
    contentType: 'application/json',
  });
  expect(frames.find((frame) => frame.shell !== null || frame.app)?.shell).toBeTruthy();
  expect(frames.some((frame) => frame.app)).toBe(true);
  return frames;
}

export async function openChat(page: Page) {
  await page.goto('/c/new');
  await expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 30000 });
}

/** The session expiry the server mirrors in a page-readable cookie, in epoch milliseconds. */
export async function sessionHint(page: Page): Promise<SessionHint | undefined> {
  const value = await page.evaluate(
    (name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie)?.[1],
    SESSION_HINT_COOKIE,
  );
  return value ? parseSessionHint(decodeURIComponent(value)) : undefined;
}

/** Rewrites the page-readable session hint as `change` says, leaving the session cookies alone. */
export async function rewriteSessionHint(page: Page, change: (hint: SessionHint) => SessionHint) {
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

export const rgb = (channels?: string) => `rgb(${(channels ?? '').split(' ').join(', ')})`;

/** Reloads throttled with the config held, and checks every frame before the answer. */
export async function expectFirstPaint(page: Page, mode: Mode) {
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
