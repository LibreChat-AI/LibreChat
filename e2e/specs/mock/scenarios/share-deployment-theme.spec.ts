import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { defaultTheme } from '../../../../packages/client/src/theme/themes/default';
import { darkTheme } from '../../../../packages/client/src/theme/themes/dark';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  getAccessToken,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from '../helpers';
import { themeValue } from './style.helpers';

/**
 * A shared link resolves its policy from the tenant that owns it, so the viewer's
 * tenant and the link's tenant can configure different `interface.theme` values.
 * The two tenants are stood in for by the two payloads: `/api/config` carries the
 * viewer tenant's theme and `/api/share/:shareId/config` the link tenant's, each
 * layered over the real server response.
 */

type Mode = 'light' | 'dark';
/** `null` serves a payload with no `interface.theme`. */
type ConfigTheme = string | Record<string, unknown> | null;

const VIEWER_THEME = {
  version: 1,
  name: 'viewer',
  modes: {
    light: { colors: { 'rgb-surface-primary': '240 244 255' } },
    dark: { colors: { 'rgb-surface-primary': '12 16 32' } },
  },
};

async function serveThemes(page: Page, viewer: ConfigTheme, link: ConfigTheme) {
  const withTheme = (payload: { interface?: Record<string, unknown> }, theme: ConfigTheme) => {
    const served = { ...payload.interface };
    delete served.theme;
    if (theme !== null) {
      served.theme = theme;
    }
    return { ...payload, interface: served };
  };
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: withTheme(await response.json(), viewer) });
    },
  );
  await page.route(
    (url) => /^\/api\/share\/[^/]+\/config$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: withTheme(await response.json(), link) });
    },
  );
}

/** Creates a public link to a fresh conversation through the share API. */
async function createSharedLink(page: Page, text = `Shared theme ${Date.now()}`): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, text);
  await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
  const conversationId = new URL(page.url()).pathname.split('/').pop();
  const token = await getAccessToken(page);
  const response = await page.request.post(`/api/share/${conversationId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(response.ok()).toBeTruthy();
  const { shareId } = (await response.json()) as { shareId?: string };
  if (!shareId) {
    throw new Error('Expected create-share response to include a shareId');
  }
  return shareId;
}

async function openSharedLink(page: Page, shareId: string) {
  await Promise.all([
    page.waitForResponse(
      (res) => new URL(res.url()).pathname === `/api/share/${shareId}/config` && res.ok(),
    ),
    page.goto(`/share/${shareId}`, { timeout: 10000 }),
  ]);
  await expect(page.getByTestId('messages-view')).toBeVisible({ timeout: 20000 });
}

const backgroundOf = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);

async function resolvedMode(page: Page): Promise<Mode> {
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  return dark ? 'dark' : 'light';
}

async function expectViewerTheme(page: Page) {
  const mode = await resolvedMode(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'viewer');
  expect(await themeValue(page, '--surface-primary')).toBe(
    VIEWER_THEME.modes[mode].colors['rgb-surface-primary'],
  );
}

test.describe('deployment theme on a shared link', () => {
  test("a shared link paints its own tenant's deployment theme, not the viewer's @scenario:shared-link-paints-link-tenant-theme", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await serveThemes(page, VIEWER_THEME, 'clickhouse');
    const shareId = await createSharedLink(page);
    await expectViewerTheme(page);

    await openSharedLink(page, shareId);
    const colors = clickHouseTheme.modes[await resolvedMode(page)]?.colors ?? {};
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    expect(await themeValue(page, '--surface-primary')).toBe(colors['rgb-surface-primary']);
    expect(await page.evaluate(() => localStorage.getItem('theme-definition'))).toBeNull();

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expectViewerTheme(page);
  });

  test("a shared link whose tenant sets no theme does not paint the viewer's @scenario:shared-link-without-theme-skips-viewer-theme", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await serveThemes(page, VIEWER_THEME, null);
    const shareId = await createSharedLink(page);
    await expectViewerTheme(page);

    await openSharedLink(page, shareId);
    const palette = (await resolvedMode(page)) === 'dark' ? darkTheme : defaultTheme;
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'viewer');
    expect(await themeValue(page, '--surface-primary')).toBe(palette['rgb-surface-primary']);
  });

  test('the user bubble on a shared link stands out from the page like it does in chat @scenario:shared-link-user-bubble-visible', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const text = `Bubble ${Date.now()}`;
    await serveThemes(page, null, 'clickhouse');
    const shareId = await createSharedLink(page, text);

    await openSharedLink(page, shareId);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    const bubble = page.getByTestId('message-body').filter({ hasText: text });
    await expect(bubble).toBeVisible();
    const bubbleColor = await bubble.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(await backgroundOf(page, 'main')).toBe(
      await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.className = 'bg-presentation';
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      }),
    );
    expect(bubbleColor).not.toBe(await backgroundOf(page, 'main'));
  });

  test("a shared link whose config request fails does not keep the viewer's theme @scenario:shared-link-config-failure-drops-viewer-theme", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await serveThemes(page, VIEWER_THEME, null);
    const shareId = await createSharedLink(page);
    await expectViewerTheme(page);
    await page.route(
      (url) => url.pathname === `/api/share/${shareId}/config`,
      (route) => route.fulfill({ status: 500, json: { message: 'unavailable' } }),
    );

    await page.goto(`/share/${shareId}`, { timeout: 10000 });
    await expect(page.getByTestId('messages-view')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'viewer', {
      timeout: 30000,
    });
  });

  test("a slow shared config never shows the conversation in the viewer's theme @scenario:shared-link-waits-for-link-theme", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await serveThemes(page, VIEWER_THEME, 'clickhouse');
    const shareId = await createSharedLink(page);
    await page.route(
      (url) => url.pathname === `/api/share/${shareId}/config`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await route.fallback();
      },
    );

    await page.goto(`/share/${shareId}`, { timeout: 10000 });
    await page.getByTestId('messages-view').waitFor({ timeout: 20000 });
    expect(await page.locator('html').getAttribute('data-theme')).toBe('clickhouse');
  });
});
