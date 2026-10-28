import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { probeStyle } from './style.helpers';

/**
 * The ClickHouse theme sets the radius, mono and shadow scales as well as its colours, so the
 * plain `rounded-*`, `font-mono` and `shadow-*` utilities take Click UI's shape. The mention menu
 * carries `rounded-2xl` and `shadow-lg` and opens from the composer, which makes it one real
 * element on both scales. The mode comes from the project, and every expectation is read for the
 * mode the page actually resolved.
 */
test.describe.configure({ timeout: 120_000 });

type Mode = 'light' | 'dark';

const SHADOW_ALPHA: Record<Mode, number> = { light: 0.15, dark: 0.6 };

async function storeClickHouse(page: Page) {
  await page.addInitScript((theme) => {
    localStorage.removeItem('theme-colors');
    localStorage.removeItem('theme-name');
    localStorage.setItem('theme-definition', JSON.stringify(theme));
    localStorage.setItem('theme-source', 'definition');
  }, clickHouseTheme);
}

/** Serves `interface.theme: clickhouse` on `/api/config`, the way librechat.yaml delivers it. */
async function serveClickHouse(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, interface: { ...body.interface, theme: 'clickhouse' } },
      });
    },
  );
}

async function openMentionMenu(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  const composer = page.getByRole('textbox', { name: 'Message input' });
  await expect(composer).toBeVisible({ timeout: 30000 });
  await composer.click();
  await composer.pressSequentially('@');
  const search = page.getByPlaceholder('Mention an endpoint');
  await expect(search).toBeVisible({ timeout: 15000 });
  const menu = page.locator('div.popover').filter({ has: search });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Paints code text, waits for the browser to settle its font loads, and reports the status of
 * every declared Inconsolata face. A face is fetched only once text renders in it.
 */
async function inconsolataStatuses(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const probe = document.createElement('code');
    probe.textContent = 'const probe = 0;';
    document.body.append(probe);
    await document.fonts.ready;
    probe.remove();
    return [...document.fonts]
      .filter((face) => face.family.replace(/"/g, '') === 'Inconsolata')
      .map((face) => face.status);
  });
}

async function resolvedMode(page: Page): Promise<Mode> {
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  return dark ? 'dark' : 'light';
}

async function expectClickUiShape(page: Page, menu: Locator) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
  const alpha = SHADOW_ALPHA[await resolvedMode(page)];

  /** Click UI's `genericMenu.panel.radii.all`, the popover role's ClickHouse value. */
  await expect(menu).toHaveCSS('border-radius', '4px');
  const shadow = await menu.evaluate((node) => getComputedStyle(node).boxShadow);
  expect(shadow).toContain(`rgba(21, 21, 21, ${alpha}) 0px 4px 6px -1px`);
  expect(shadow).toContain(`rgba(21, 21, 21, ${alpha}) 0px 2px 4px -1px`);
}

test.describe('ClickHouse theme shape', () => {
  test('the ClickHouse theme draws the mention menu with Click UI corners and elevation @scenario:clickhouse-theme-reshapes-mention-menu', async ({
    page,
  }) => {
    await storeClickHouse(page);

    const menu = await openMentionMenu(page);

    await expectClickUiShape(page, menu);
  });

  test('interface.theme clickhouse reshapes the mention menu without a stored theme @scenario:clickhouse-deployment-theme-reshapes-mention-menu', async ({
    page,
  }) => {
    await serveClickHouse(page);

    const menu = await openMentionMenu(page);

    await expectClickUiShape(page, menu);
    expect(await page.evaluate(() => localStorage.getItem('theme-definition'))).toBeNull();
  });

  test('theme controls take Click UI control height, checked fill and focus outline @scenario:clickhouse-controls-follow-click-ui', async ({
    page,
  }) => {
    await storeClickHouse(page);

    await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    const mode = await resolvedMode(page);

    /** `genericMenu.panel.size.height` and `transition.default`; the shared spacing role that
     *  also pads message bubbles keeps LibreChat's 12px. */
    expect(await probeStyle(page, 'h-theme-control', 'height')).toBe('32px');
    expect(await probeStyle(page, 'px-theme-normal', 'padding-left')).toBe('12px');
    expect(await probeStyle(page, 'duration-theme-fast', 'transition-duration')).toBe('0.1s');
    /** The checked checkbox and switch fill, and `outline.default`. */
    const fill = mode === 'light' ? 'rgb(21, 21, 21)' : 'rgb(250, 255, 105)';
    const ring = mode === 'light' ? 'rgb(67, 126, 239)' : 'rgb(250, 255, 105)';
    expect(await probeStyle(page, 'bg-surface-inverted', 'background-color')).toBe(fill);
    expect(await probeStyle(page, 'ring-2 ring-ring-primary', 'box-shadow')).toContain(ring);
  });

  test('code text, the second motion step and the hairline shadow follow Click UI @scenario:clickhouse-code-text-and-motion-follow-click-ui', async ({
    page,
  }) => {
    await storeClickHouse(page);

    await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');
    const mode = await resolvedMode(page);

    /** `codeblock.lightMode.color.text` and `codeblock.darkMode.color.text`. */
    const code = mode === 'light' ? 'rgb(40, 40, 40)' : 'rgb(255, 255, 255)';
    expect(await probeStyle(page, 'hljs', 'color', 'code')).toBe(code);
    /** `transition.duration.smooth`, and `shadow.5` for the lightest shadow step. */
    expect(await probeStyle(page, 'duration-theme-normal', 'transition-duration')).toBe('0.15s');
    expect(await probeStyle(page, 'shadow-2xs', 'box-shadow')).toContain(
      'rgba(0, 0, 0, 0.03) 0px 2px 2px 0px',
    );
  });

  test('monospace text under the ClickHouse theme leads with Inconsolata @scenario:clickhouse-mono-font-leads-with-inconsolata', async ({
    page,
  }) => {
    await storeClickHouse(page);

    await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');

    const family = await probeStyle(page, 'font-mono', 'font-family');
    expect(family.replace(/"/g, '').startsWith('Inconsolata')).toBe(true);
    expect(family).toContain('monospace');
  });

  test('the ClickHouse theme renders code in the self-hosted Inconsolata face @scenario:clickhouse-mono-font-is-bundled', async ({
    page,
  }) => {
    const fetched: string[] = [];
    page.on('requestfinished', (request) => {
      if (/inconsolata-latin-\d+-normal/.test(request.url())) {
        fetched.push(request.url());
      }
    });
    await storeClickHouse(page);

    await openMentionMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'clickhouse');

    expect(await inconsolataStatuses(page)).toContain('loaded');
    expect(await page.evaluate(() => document.fonts.check('16px Inconsolata'))).toBe(true);
    expect(fetched).not.toHaveLength(0);
  });

  test('the production build serves the Inconsolata licence beside the font @scenario:inconsolata-licence-ships-with-font', async ({
    page,
  }) => {
    const font = await page.request.get('/assets/fonts/inconsolata-latin-400-normal.woff2');
    expect(font.status()).toBe(200);

    const licence = await page.request.get('/assets/fonts/inconsolata-OFL.txt');
    expect(licence.status()).toBe(200);
    const text = await licence.text();
    expect(text).toContain('Copyright 2006 The Inconsolata Project Authors');
    expect(text).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  test('the default theme never fetches Inconsolata @scenario:default-theme-skips-inconsolata', async ({
    page,
  }) => {
    const fetched: string[] = [];
    page.on('request', (request) => {
      if (/inconsolata/i.test(request.url())) {
        fetched.push(request.url());
      }
    });

    await openMentionMenu(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'clickhouse');

    const statuses = await inconsolataStatuses(page);
    expect(statuses).not.toHaveLength(0);
    expect(statuses.every((status) => status === 'unloaded')).toBe(true);
    expect(fetched).toEqual([]);
  });
});
