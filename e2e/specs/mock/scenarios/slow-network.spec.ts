import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  modelSelectorTrigger,
  selectMockEndpoint,
} from '../helpers';
import { expect, test } from '../fixtures';

const messageInput = (page: Page) => page.getByRole('textbox', { name: 'Message input' });

const KEY_ENDPOINT = MOCK_ENDPOINTS[1];

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
    await expect(indicator).toHaveText('Loading');
    await expect
      .poll(() => indicator.evaluate((el) => Number(getComputedStyle(el).opacity)), {
        timeout: 5000,
      })
      .toBeGreaterThan(0);
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
    await requireUserKey(page, KEY_ENDPOINT.label);
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await modelSelectorTrigger(page).click();

    const keyButton = page.getByRole('button', { name: `Set API Key ${KEY_ENDPOINT.label}` });
    await expect(keyButton).toBeVisible();
    const box = await keyButton.boundingBox();
    expect(box).not.toBeNull();
    const coarse = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
    const minimum = coarse ? 32 : 24;
    expect(box!.height).toBeGreaterThanOrEqual(minimum);
    expect(box!.width).toBeGreaterThanOrEqual(minimum);

    /* The larger target spills into the row's padding; the row keeps its neighbours' height. */
    const rowHeight = (label: string) =>
      page
        .getByRole('option', { name: new RegExp(`^${label}`) })
        .first()
        .evaluate((el) => el.getBoundingClientRect().height);
    expect(await rowHeight(KEY_ENDPOINT.label)).toBe(await rowHeight(MOCK_ENDPOINTS[0].label));
  });
});
