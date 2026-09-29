import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { IThemeRGB } from '../../../../packages/client/src/theme/types';
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
import { getE2EUser } from '../../../setup/user';
import { themeValue } from './style.helpers';

/**
 * What the browser paints while a controlled theme arrives, and the roles that
 * Markdown and the share dialog read. `/api/config` carries the viewer tenant's
 * theme and `/api/share/:shareId/config` the link tenant's, layered over the real
 * server response. Frames are sampled in `requestAnimationFrame`, which runs just
 * before each paint, so a sample is what the next frame shows.
 */

type Mode = 'light' | 'dark';
/** `null` serves a payload with no `interface.theme`. */
type ConfigTheme = string | Record<string, unknown> | null;
type Frame = { marker: boolean; theme: string | null; surface: string };

const VIEWER_THEME = {
  version: 1,
  name: 'viewer',
  modes: {
    light: { colors: { 'rgb-surface-primary': '240 244 255' } },
    dark: { colors: { 'rgb-surface-primary': '12 16 32' } },
  },
};

/** Names a link and a QR backdrop and leaves the prose link role to its fallback. */
const LINK_THEME = {
  version: 1,
  name: 'link-reference',
  modes: {
    light: { colors: { 'rgb-link': '160 40 120', 'rgb-surface-qr': '250 246 230' } },
    dark: { colors: { 'rgb-link': '250 200 90', 'rgb-surface-qr': '250 246 230' } },
  },
};

const withTheme = (payload: { interface?: Record<string, unknown> }, theme: ConfigTheme) => {
  const served = { ...payload.interface };
  delete served.theme;
  if (theme !== null) {
    served.theme = theme;
  }
  return { ...payload, interface: served };
};

async function serveThemes(page: Page, viewer: ConfigTheme, link: ConfigTheme = viewer) {
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

/** Records every frame from the first one that shows `selector`, before any app script runs. */
async function recordFrames(page: Page, selector: string) {
  await page.addInitScript((marker) => {
    const frames: Array<{ marker: boolean; theme: string | null; surface: string }> = [];
    (window as unknown as { __themeFrames: typeof frames }).__themeFrames = frames;
    const sample = () => {
      const root = document.documentElement;
      frames.push({
        marker: document.querySelector(marker) != null,
        theme: root.getAttribute('data-theme'),
        surface: getComputedStyle(root).getPropertyValue('--surface-primary').trim(),
      });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, selector);
}

const shownFrames = async (page: Page): Promise<Frame[]> =>
  (
    await page.evaluate(() => (window as unknown as { __themeFrames: Frame[] }).__themeFrames ?? [])
  ).filter((frame) => frame.marker);

async function resolvedMode(page: Page): Promise<Mode> {
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  return dark ? 'dark' : 'light';
}

async function createSharedLink(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, `Theme paint ${Date.now()}`);
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

/** Colors of a Markdown link, inline code and the QR backdrop, as the shipped CSS paints them. */
function paintRoles(page: Page) {
  return page.evaluate(() => {
    const host = document.createElement('section');
    const prose = document.createElement('div');
    prose.className = 'prose dark:prose-invert markdown';
    const paragraph = document.createElement('p');
    const link = document.createElement('a');
    link.href = '#probe';
    link.textContent = 'link';
    const code = document.createElement('code');
    code.textContent = 'code';
    paragraph.append(link, ' ', code);
    prose.append(paragraph);
    const qr = document.createElement('div');
    qr.className = 'bg-surface-qr';
    host.append(prose, qr);
    document.body.append(host);
    const read = (node: Element, property: string) =>
      getComputedStyle(node).getPropertyValue(property).trim();
    const roles = {
      link: read(link, 'color'),
      codeFill: read(code, 'background-color'),
      qr: read(qr, 'background-color'),
    };
    host.remove();
    return roles;
  });
}

const rgb = (channels: string | undefined) => `rgb(${(channels ?? '').split(' ').join(', ')})`;

test.describe('controlled theme paint', () => {
  test("a shared link's first frame of the conversation already wears the link tenant's theme @scenario:shared-link-first-frame-wears-link-theme", async ({
    page,
  }) => {
    test.setTimeout(120000);
    await serveThemes(page, VIEWER_THEME, 'clickhouse');
    const shareId = await createSharedLink(page);

    await recordFrames(page, '[data-testid="messages-view"]');
    await page.goto(`/share/${shareId}`, { timeout: 10000 });
    await expect(page.getByTestId('messages-view')).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await shownFrames(page)).length).toBeGreaterThan(2);

    const surface =
      clickHouseTheme.modes[await resolvedMode(page)]?.colors?.['rgb-surface-primary'];
    const frames = await shownFrames(page);
    expect(frames.filter((frame) => frame.theme !== 'clickhouse')).toEqual([]);
    expect(frames.filter((frame) => frame.surface !== surface)).toEqual([]);
  });

  test.describe('signed out', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('the login form first paints in the deployment theme @scenario:login-first-frame-wears-deployment-theme', async ({
      page,
    }) => {
      test.setTimeout(60000);
      await serveThemes(page, 'clickhouse');
      await recordFrames(page, '[data-testid="login-button"]');

      await page.goto('/login');
      await expect(page.getByTestId('login-button')).toBeVisible({ timeout: 20000 });
      await expect.poll(async () => (await shownFrames(page)).length).toBeGreaterThan(2);

      const frames = await shownFrames(page);
      expect(frames.filter((frame) => frame.theme !== 'clickhouse')).toEqual([]);

      const user = getE2EUser();
      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill(user.password);
      await page.getByTestId('login-button').click();
      await page.waitForURL(/\/c\/new/, { timeout: 20000 });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    });
  });

  test('Markdown links, inline code and the QR backdrop keep the default look @scenario:prose-and-qr-roles-keep-default-look', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await serveThemes(page, null);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 20000,
    });

    const dark = (await resolvedMode(page)) === 'dark';
    const roles = await paintRoles(page);
    expect(roles.link).toBe(rgb(dark ? darkTheme['rgb-text-primary'] : defaultTheme['rgb-link']));
    expect(roles.codeFill).toBe(
      rgb(dark ? darkTheme['rgb-surface-hover-alt'] : defaultTheme['rgb-surface-active-alt']),
    );
    expect(roles.qr).toBe('rgb(255, 255, 255)');
  });

  test('the ClickHouse theme paints its own link, code fill and QR backdrop @scenario:clickhouse-prose-and-qr-roles', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await serveThemes(page, 'clickhouse');
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');

    const dark = (await resolvedMode(page)) === 'dark';
    const colors: IThemeRGB = clickHouseTheme.modes[dark ? 'dark' : 'light']?.colors ?? {};
    const roles = await paintRoles(page);
    expect(roles.link).toBe(rgb(colors['rgb-link-prose']));
    expect(roles.codeFill).toBe(
      rgb(dark ? colors['rgb-surface-hover-alt'] : colors['rgb-surface-active-alt']),
    );
    expect(roles.qr).toBe(rgb(colors['rgb-surface-qr']));
  });

  test('a theme that names only its link colours Markdown links in both modes and can recolour the QR backdrop @scenario:theme-link-reaches-prose-links', async ({
    page,
  }) => {
    test.setTimeout(60000);
    await serveThemes(page, LINK_THEME);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'link-reference');

    const mode = await resolvedMode(page);
    const roles = await paintRoles(page);
    expect(roles.link).toBe(rgb(LINK_THEME.modes[mode].colors['rgb-link']));
    expect(roles.qr).toBe(rgb(LINK_THEME.modes[mode].colors['rgb-surface-qr']));
    expect(await themeValue(page, '--surface-qr')).toBe('250 246 230');
  });
});
