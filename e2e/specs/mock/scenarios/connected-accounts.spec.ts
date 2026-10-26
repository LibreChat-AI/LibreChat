import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { accountButton } from './ui-scale.helpers';

/**
 * The Connected Accounts row in Settings > Account. The mock config has no pull request OAuth
 * app, so startup is told one is configured and the connection endpoints are answered here:
 * each test drives the row through the states a real server reports.
 */

type Status = { configured: boolean; connected: boolean; provider: 'github' } | 'error';

const connected: Status = { configured: true, connected: true, provider: 'github' };
const disconnected: Status = { configured: true, connected: false, provider: 'github' };

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** The PWA service worker serves API GETs itself, which would bypass every `page.route` below. */
test.use({ serviceWorkers: 'block' });

/** Answers the status endpoint with whatever `state.status` holds when the request arrives. */
async function mockConnection(page: Page, initial: Status) {
  const state = { status: initial };
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({ response, json: { ...config, pullRequestsConnect: 'github' } });
  });
  await page.route('**/api/pull-requests/oauth/status', (route) =>
    state.status === 'error'
      ? json(route, { error: 'unavailable' }, 500)
      : json(route, state.status),
  );
  return state;
}

async function openConnectedAccounts(page: Page) {
  await page.goto('/c/new', { timeout: 10000 });
  await (await accountButton(page)).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: /Settings/ });
  await settings.getByRole('tab', { name: 'Account' }).click();
  const row = settings.getByRole('group', { name: 'GitHub' });
  await expect(row).toBeVisible();
  return row;
}

test.describe('connected accounts', () => {
  test('an unconnected account offers Connect as the primary action and announces its state @scenario:connected-accounts-not-connected', async ({
    page,
  }) => {
    await mockConnection(page, disconnected);
    const row = await openConnectedAccounts(page);

    await expect(row.getByRole('status')).toHaveText('Not connected');
    const connect = row.getByRole('button', { name: 'Connect GitHub' });
    await expect(connect).toBeVisible();
    await expect(connect).toHaveText('Connect');
    await connect.focus();
    await expect(connect).toBeFocused();
  });

  test('confirming Disconnect ends the connection and moves focus to Connect @scenario:connected-accounts-disconnect-confirmed', async ({
    page,
  }) => {
    const state = await mockConnection(page, connected);
    let deletes = 0;
    await page.route('**/api/pull-requests/oauth', (route) => {
      if (route.request().method() !== 'DELETE') {
        return route.fallback();
      }
      deletes += 1;
      state.status = disconnected;
      return json(route, { connected: false });
    });
    const row = await openConnectedAccounts(page);

    await expect(row.getByRole('status')).toHaveText('Connected');
    await row.getByRole('button', { name: 'Disconnect GitHub' }).click();
    const confirm = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();

    await expect(confirm).toBeHidden();
    expect(deletes).toBe(1);
    await expect(row.getByRole('button', { name: 'Connect GitHub' })).toBeFocused();
  });

  test('a failed disconnect keeps the confirmation open with an error, and Cancel returns focus @scenario:connected-accounts-disconnect-failed', async ({
    page,
  }) => {
    await mockConnection(page, connected);
    await page.route('**/api/pull-requests/oauth', (route) =>
      route.request().method() === 'DELETE'
        ? json(route, { error: 'failed' }, 500)
        : route.fallback(),
    );
    const row = await openConnectedAccounts(page);

    const trigger = row.getByRole('button', { name: 'Disconnect GitHub' });
    await trigger.click();
    const confirm = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
    await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();

    await expect(confirm.getByRole('alert')).toHaveText("Couldn't disconnect. Try again.");
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(row.getByRole('status')).toHaveText('Connected');
  });

  test('a failed status check shows an error and Retry recovers the real state @scenario:connected-accounts-status-retry', async ({
    page,
  }) => {
    const state = await mockConnection(page, 'error');
    const row = await openConnectedAccounts(page);

    await expect(row.getByRole('status')).toHaveText("Couldn't check the connection", {
      timeout: 20000,
    });
    state.status = connected;
    const retry = row.getByRole('button', { name: 'Retry' });
    await retry.click();

    await expect(row.getByRole('status')).toHaveText('Connected');
    await expect(row.getByRole('button', { name: 'Disconnect GitHub' })).toBeFocused();
  });

  test('a connect request the server rejects explains the failure in the row @scenario:connected-accounts-connect-failed', async ({
    page,
  }) => {
    await mockConnection(page, disconnected);
    await page.route('**/api/pull-requests/oauth/connect', (route) =>
      json(route, { error: 'failed' }, 500),
    );
    const row = await openConnectedAccounts(page);

    const popup = page.waitForEvent('popup');
    await row.getByRole('button', { name: 'Connect GitHub' }).click();

    await expect(row.getByRole('alert')).toHaveText("Couldn't start connecting. Try again.");
    /** The blank window opened in the click is closed rather than left behind. */
    const opened = await popup;
    await expect.poll(() => opened.isClosed()).toBe(true);
    await expect(row.getByRole('button', { name: 'Connect GitHub' })).toHaveText('Connect');
  });
});
