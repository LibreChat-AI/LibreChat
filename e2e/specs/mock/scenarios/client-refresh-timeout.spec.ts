import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * A token refresh that never answers must not freeze the app: the deadline published in the
 * startup config (`clientTimeouts.refreshMs`) expires and the visitor lands on the sign-in page.
 */
test('a hung token refresh sends the visitor to login after the configured deadline @scenario:client-refresh-timeout', async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, clientTimeouts: { refreshMs: 1500 } } });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/auth/refresh',
    () => new Promise<void>(() => undefined),
  );

  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });

  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  await expect(page.getByTestId('login-button')).toBeVisible();
});
