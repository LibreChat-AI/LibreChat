import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import {
  readBundledThemeBoot,
  injectDeploymentThemeBoot,
} from '../../../../packages/api/src/html/theme';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { resolveTheme } from '../../../../packages/data-provider/src/themes/registry';
import { expect, test } from '../fixtures';
import type { Mode, ThemeSource } from './deployment-theme.helpers';
import {
  inlineTheme,
  CACHE_KEY,
  serveTheme,
  sampleFrames,
  throttle,
  rgb,
} from './deployment-theme.helpers';

/**
 * A first-ever visit paints the deployment theme from its first frame, signed in or on the login
 * page. Split from `deployment-theme-first-paint.spec.ts`, which covers reloads, so the shard
 * planner can place the two apart.
 */

// Use full Chromium locally, matching CI's Chrome, without trace or video capture
// competing with protocol calls under CPU throttling. Failure screenshots remain enabled.
test.use({ channel: process.env.E2E_CHROMIUM_CHANNEL ?? 'chromium', trace: 'off', video: 'off' });

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
      // The hidden audio iframe is a binary document, not an app shell.
      if (
        route.request().resourceType() !== 'document' ||
        route.request().frame() !== page.mainFrame()
      ) {
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
  const frames = (await page.evaluate(() => window.__themeFrames ?? [])).filter(
    (frame) => frame.at < answered,
  );
  await test.info().attach('first-visit-theme-frames', {
    body: Buffer.from(JSON.stringify(frames, null, 2)),
    contentType: 'application/json',
  });
  return frames;
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
