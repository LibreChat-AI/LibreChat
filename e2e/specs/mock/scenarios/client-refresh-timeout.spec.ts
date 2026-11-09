import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * A token refresh that never answers must not freeze the app: the deadline published in the
 * startup config (`clientLimits.refreshMs`, kept from the previous load) expires and the visitor lands on the sign-in page.
 */
test('a hung token refresh sends the visitor to login after the configured deadline @scenario:client-refresh-timeout', async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, clientLimits: { refreshMs: 1500 } } });
    },
  );
  let hangRefresh = false;
  await page.route(
    (url) => url.pathname === '/api/auth/refresh',
    (route) => (hangRefresh ? new Promise<void>(() => undefined) : route.continue()),
  );

  /** The first load publishes the deadline; the next load's refresh starts with it already known. */
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  await page.waitForFunction(() => localStorage.getItem('librechat:clientLimits') != null, null, {
    timeout: 15000,
  });
  hangRefresh = true;
  await page.goto(NEW_CHAT_PATH, { timeout: 15000, waitUntil: 'commit' });

  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  await expect(page.getByTestId('login-button')).toBeVisible();
});
