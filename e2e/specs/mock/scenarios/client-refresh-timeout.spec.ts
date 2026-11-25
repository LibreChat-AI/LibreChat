import { NEW_CHAT_PATH } from '../helpers';
import { expect, test } from '../fixtures';

/**
 * A token refresh that never answers must not freeze the app: the deadline published in the
 * startup config (`clientLimits.refreshMs`, kept from the previous load) expires. A timeout is not a
 * session denial, so the session is kept and the visitor sees the session-check Retry screen, whose
 * "Sign in again" action opens the sign-in page without waiting for the session service.
 */
test('a hung token refresh shows the session-check Retry screen after the configured deadline @scenario:client-refresh-timeout', async ({
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

  await expect(
    page.getByRole('heading', { level: 1, name: "We couldn't verify your session" }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(new RegExp(`${NEW_CHAT_PATH}$`));
  await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();

  await page.getByRole('button', { name: 'Sign in again' }).click();

  await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  await expect(page.getByTestId('login-button')).toBeVisible();
});
