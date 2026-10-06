import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { resolveTheme } from '../../../../packages/client/src/theme/registry';

/**
 * `interface.theme` exists only in the `/api/config` answer, so before this
 * change a signed-in reload painted the chat in the default palette until that
 * answer arrived. The reload now replays the last served deployment theme from
 * the inline boot script in `client/index.html` and from `DeploymentTheme`'s
 * cache, so every frame before the answer already wears it.
 *
 * The reload runs throttled (400 ms latency, 1.5 Mbps, 4x CPU) and the config
 * answer is held back further, so frames of both the loading shell and the
 * rendered app (the chat layout paints before the config answers; the composer
 * waits for it) land before it. Every frame is sampled in a
 * `requestAnimationFrame` callback, which runs before the frame paints.
 */

type Mode = 'light' | 'dark';

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

const CONFIG_HOLD_MS = 1500;
const CACHE_KEY = 'deployment-theme';

/**
 * Serves `theme` as `interface.theme` (`null` removes it), holding the answer while
 * `held()`. Returns when each signed-in answer was sent: that answer is the one
 * carrying the signed-in theme, so the frames before it are the ones under test.
 */
async function serveTheme(page: Page, theme: () => string | null, held: () => boolean) {
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
        await new Promise((resolve) => setTimeout(resolve, CONFIG_HOLD_MS));
      }
      if (route.request().headers()['authorization']) {
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

async function openChat(page: Page) {
  await page.goto('/c/new');
  await expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 30000 });
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

  await sampleFrames(page);
  await throttle(page);
  held = true;
  const reloadedAt = Date.now();
  await page.reload();
  await expect(page.getByTestId('composer-surface')).toBeVisible({ timeout: 60000 });
  await expect.poll(() => answeredAt.some((at) => at > reloadedAt)).toBe(true);

  const answered = Math.min(...answeredAt.filter((at) => at > reloadedAt));
  const frames = (await page.evaluate(() => window.__themeFrames ?? [])).filter(
    (frame) => frame.at < answered,
  );

  /** Frames of both surfaces landed before the answer, so both were tested. */
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0].shell).not.toBeNull();
  expect(frames.some((frame) => frame.app)).toBe(true);

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
