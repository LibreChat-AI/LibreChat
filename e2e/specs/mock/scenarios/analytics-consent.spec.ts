import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  sendMessageAndWaitForCompletion,
  selectMockEndpoint,
  getAccessToken,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from '../helpers';
import { openSettings } from './ui-scale.helpers';

/**
 * A deployment that sets `ANALYTICS_GTM_ID` used to load Google Tag Manager on
 * the first render. It now loads only after the viewer allows it, on the signed-in
 * app and on a shared link alike, and the answer can be withdrawn in Settings.
 *
 * The id reaches the client through `/api/config` and `/api/share/:shareId/config`,
 * so it is layered over the real responses here instead of restarting the shared
 * harness server with a different environment. Requests to Google Tag Manager are
 * answered locally with an empty script and counted: a request is the observable
 * the consent decision controls.
 */

const GTM_ID = 'GTM-E2ETEST';

type Probe = { requests: () => number };

/** Stands in for gtm.js: registers the container under its id, as GTM does once loaded. */
const GTM_STUB = `(() => {
  const id = new URL(document.currentScript.src).searchParams.get('id');
  window.google_tag_manager = window.google_tag_manager || {};
  window.google_tag_manager[id] = {};
})();`;

/** A request that should not happen has no event to wait on, so absence is
 *  observed over a short settle window after the config arrived; the page holds
 *  open streams, so `networkidle` never fires. */
const SETTLE_MS = 1500;

async function expectNoGtm(page: Page, gtm: Probe, expected: number) {
  await page.waitForTimeout(SETTLE_MS);
  expect(gtm.requests()).toBe(expected);
  await expect(page.locator('script[src*="googletagmanager.com"]')).toHaveCount(0);
}

async function serveGtmId(page: Page, gtmId: string | null = GTM_ID): Promise<Probe> {
  const withId = (payload: Record<string, unknown>) => {
    const served = { ...payload };
    delete served.analyticsGtmId;
    if (gtmId !== null) {
      served.analyticsGtmId = gtmId;
    }
    return served;
  };
  await page.route(
    (url) => url.pathname === '/api/config' || /^\/api\/share\/[^/]+\/config$/.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: withId(await response.json()) });
    },
  );
  let requests = 0;
  await page.route('**://*.googletagmanager.com/**', async (route) => {
    requests += 1;
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: GTM_STUB });
  });
  return { requests: () => requests };
}

const banner = (page: Page) => page.getByRole('region', { name: 'Analytics consent' });
const allowButton = (page: Page) => banner(page).getByRole('button', { name: 'Allow analytics' });
const declineButton = (page: Page) => banner(page).getByRole('button', { name: 'Decline' });

/** The app shell is up once the composer renders and the startup config, which
 *  carries the tag manager id, has arrived. */
async function openNewChat(page: Page) {
  await Promise.all([
    page.waitForResponse((res) => new URL(res.url()).pathname === '/api/config' && res.ok()),
    page.goto(NEW_CHAT_PATH, { timeout: 15000 }),
  ]);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 20000,
  });
}

async function openDataSettings(page: Page) {
  await openSettings(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Data & Privacy' }).click();
  return dialog.getByRole('switch', { name: 'Allow analytics' });
}

/** The last consent mode answer the page gave a loaded container, if any. */
const lastConsentUpdate = (page: Page) =>
  page.evaluate(() =>
    ((window as Window & { dataLayer?: unknown[] }).dataLayer ?? []).reduce<string | null>(
      (last, entry) => {
        const args = entry as ArrayLike<unknown> | null;
        if (args == null || typeof args !== 'object' || args[0] !== 'consent') {
          return last;
        }
        const state = args[2] as { analytics_storage?: string } | undefined;
        return args[1] === 'update' ? (state?.analytics_storage ?? last) : last;
      },
      null,
    ),
  );

async function createSharedLink(page: Page): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await sendMessageAndWaitForCompletion(page, `Shared analytics ${Date.now()}`);
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

test.describe('analytics consent', () => {
  test('Google Tag Manager loads only after the viewer allows analytics @scenario:gtm-loads-only-after-consent', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const gtm = await serveGtmId(page);
    await openNewChat(page);

    await expect(banner(page)).toBeVisible();
    expect(gtm.requests()).toBe(0);

    await allowButton(page).click();
    await expect(banner(page)).toHaveCount(0);
    await expect.poll(gtm.requests).toBeGreaterThan(0);

    /** The answer persists: no second prompt, and the container loads on the next visit. */
    const before = gtm.requests();
    await openNewChat(page);
    await expect.poll(gtm.requests).toBeGreaterThan(before);
    await expect(banner(page)).toHaveCount(0);
  });

  test('declining keeps Google Tag Manager off across reloads @scenario:gtm-stays-off-after-decline', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const gtm = await serveGtmId(page);
    await openNewChat(page);

    await declineButton(page).click();
    await expect(banner(page)).toHaveCount(0);

    await openNewChat(page);
    await expect(banner(page)).toHaveCount(0);
    await expectNoGtm(page, gtm, 0);
  });

  test('a shared link asks before loading Google Tag Manager @scenario:shared-link-gtm-waits-for-consent', async ({
    page,
  }) => {
    test.setTimeout(120000);
    /** Create the link without an id configured, so the app shell never asks first. */
    await serveGtmId(page, null);
    const shareId = await createSharedLink(page);
    await page.unrouteAll({ behavior: 'wait' });

    const gtm = await serveGtmId(page);
    await page.goto(`/share/${shareId}`, { timeout: 15000 });
    await expect(page.getByTestId('messages-view')).toBeVisible({ timeout: 20000 });
    await expect(banner(page)).toBeVisible();
    expect(gtm.requests()).toBe(0);

    await allowButton(page).click();
    await expect(banner(page)).toHaveCount(0);
    await expect.poll(gtm.requests).toBeGreaterThan(0);

    /** A viewer who never signs in withdraws from the shared view's own Settings. */
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const toggle = page.getByRole('dialog').getByRole('switch', { name: 'Allow analytics' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => lastConsentUpdate(page)).toBe('denied');
  });

  test('turning analytics off in Settings withdraws consent @scenario:settings-revokes-analytics-consent', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const gtm = await serveGtmId(page);
    await openNewChat(page);
    await allowButton(page).click();
    await expect.poll(gtm.requests).toBeGreaterThan(0);

    const toggle = await openDataSettings(page);
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    /** The loaded container is told immediately; the reload completes it. */
    await expect.poll(() => lastConsentUpdate(page)).toBe('denied');

    /** Given again in the same page, the container still here is told so and
     *  no second one is requested. */
    const loaded = gtm.requests();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => lastConsentUpdate(page)).toBe('granted');
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => lastConsentUpdate(page)).toBe('denied');
    expect(gtm.requests()).toBe(loaded);

    const before = gtm.requests();
    await openNewChat(page);
    await expect(banner(page)).toHaveCount(0);
    await expectNoGtm(page, gtm, before);

    /** And it can be given again from the same place. */
    const again = await openDataSettings(page);
    await expect(again).not.toBeChecked();
    await again.click();
    await expect(again).toBeChecked();
    await expect.poll(gtm.requests).toBeGreaterThan(before);
  });

  test('a deployment without a tag manager id shows no prompt and no setting @scenario:no-gtm-id-no-consent-ui', async ({
    page,
  }) => {
    test.setTimeout(90000);
    const gtm = await serveGtmId(page, null);
    await openNewChat(page);
    await expect(banner(page)).toHaveCount(0);

    await openSettings(page);
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Data & Privacy' }).click();
    await expect(dialog.getByRole('button', { name: 'Archive all chats' })).toBeVisible();
    await expect(dialog.getByRole('switch', { name: 'Allow analytics' })).toHaveCount(0);
    expect(gtm.requests()).toBe(0);
  });
});
