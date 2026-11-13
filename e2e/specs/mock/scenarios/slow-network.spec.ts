import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  modelSelectorTrigger,
  selectMockEndpoint,
} from '../helpers';
import { expect, test } from '../fixtures';

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });

/** Providers A and B show as model specs; C and D are plain endpoint rows with models. */
const KEY_ENDPOINT = 'Mock Provider C';
const NEIGHBOUR_ENDPOINT = 'Mock Provider D';

/** No mock endpoint asks for a user key, so the served config marks one as user-provided. */
async function requireUserKey(page: Page, label: string): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/endpoints',
    async (route) => {
      const response = await route.fetch();
      const endpoints = await response.json();
      endpoints[label] = { ...endpoints[label], userProvide: true };
      await route.fulfill({ response, json: endpoints });
    },
  );
}

test.describe('slow and lost connections', () => {
  test('the loading shell shows progress while the bundle downloads @scenario:loading-shell-shows-progress-on-a-slow-load', async ({
    page,
  }) => {
    /* Hold the worker registration and the entry bundle the way a slow link does. The
       registration script used to block the parser, so nothing below it could paint. */
    await page.route(/\/registerSW\.js(\?|$)/, () => undefined);
    await page.route(/\/assets\/index\.[^/]+\.js(\?|$)/, () => undefined);
    await page.goto(NEW_CHAT_PATH, { waitUntil: 'commit' });

    const indicator = page.locator('#loading-container').getByRole('status');
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveText('Loading...');
    await expect
      .poll(() => indicator.evaluate((el) => Number(getComputedStyle(el).opacity)), {
        timeout: 5000,
      })
      .toBeGreaterThan(0);
    /* It inks in the theme's text role, not a fixed color. */
    const [ink, role] = await indicator.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'rgb(var(--text-primary))';
      document.body.appendChild(probe);
      return [getComputedStyle(el).color, getComputedStyle(probe).color];
    });
    expect(ink).toBe(role);
  });

  test('the loading label follows the language chosen before the bundle loads @scenario:loading-shell-label-follows-language', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('lang', JSON.stringify('de-DE')));
    await page.route(/\/assets\/index\.[^/]+\.js(\?|$)/, () => undefined);
    await page.goto(NEW_CHAT_PATH, { waitUntil: 'commit' });

    await expect(page.locator('#loading-container').getByRole('status')).toHaveText('Lade …');
  });

  test.describe('with the browser language', () => {
    test.use({ locale: 'zh-TW' });

    test('the loading label resolves the browser language the way the app does @scenario:loading-shell-label-follows-browser-locale', async ({
      page,
    }) => {
      /* `auto` defers to the browser, and zh-TW resolves to Traditional Chinese, not the first
         zh variant. */
      await page.addInitScript(() => localStorage.setItem('lang', JSON.stringify('auto')));
      await page.route(/\/assets\/index\.[^/]+\.js(\?|$)/, () => undefined);
      await page.goto(NEW_CHAT_PATH, { waitUntil: 'commit' });

      await expect(page.locator('#loading-container').getByRole('status')).toHaveText('載入中…');
    });
  });

  test('a message sent offline names the lost connection @scenario:offline-send-names-the-lost-connection', async ({
    page,
    context,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await expect(messageInput(page)).toBeVisible();

    await context.setOffline(true);
    await messageInput(page).fill('hello while offline');
    await messageInput(page).press('Enter');
    await expect(
      page.getByText("You're offline. Check your connection and try again."),
    ).toBeVisible({ timeout: 20000 });

    await context.setOffline(false);
    await expect(
      page.getByText('Error connecting to server, try refreshing the page.'),
    ).toBeVisible();
  });

  test('the endpoint key button is large enough to tap @scenario:endpoint-key-button-touch-target', async ({
    page,
  }) => {
    await requireUserKey(page, KEY_ENDPOINT);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await modelSelectorTrigger(page).click();

    const keyButton = page.getByRole('button', { name: `Set API Key ${KEY_ENDPOINT}` });
    await expect(keyButton).toBeVisible();
    /* Layout size, not the bounding box: the menu scales in, so a box read mid-animation is short. */
    const size = await keyButton.evaluate((el) => ({
      width: (el as HTMLElement).offsetWidth,
      height: (el as HTMLElement).offsetHeight,
    }));
    const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
    const minimum = coarse ? 32 : 24;
    expect(size.height).toBeGreaterThanOrEqual(minimum);
    expect(size.width).toBeGreaterThanOrEqual(minimum);

    /* The larger target spills into the row's padding; the row keeps its neighbours' height. */
    const rowHeight = (label: string) =>
      page
        .getByRole('option', { name: new RegExp(`^${label}`) })
        .first()
        .evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(await rowHeight(KEY_ENDPOINT)).toBe(await rowHeight(NEIGHBOUR_ENDPOINT));
  });
});
