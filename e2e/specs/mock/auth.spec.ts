import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { User } from '../../types';
import { getSecondaryE2EUser } from '../../setup/users.mock';
import cleanupUser from '../../setup/cleanupUser';
import { NEW_CHAT_PATH } from './helpers';

type AuthRecoveryTestEvent = {
  type: string;
  detail: unknown;
};

type AuthRecoveryTestWindow = Window & {
  __authRecoveryTestEvents: AuthRecoveryTestEvent[];
};

type RefreshTokenBody = {
  token?: string;
};

function createJwt(expiresAtMs: number) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAtMs / 1000) })).toString(
    'base64url',
  );
  return `header.${payload}.signature`;
}

async function getIsolatedStorageState(request: APIRequestContext, user: User) {
  await cleanupUser(user);

  const registerResponse = await request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const loginResponse = await request.post('/api/auth/login', {
    data: {
      email: user.email,
      password: user.password,
    },
  });
  expect(loginResponse.ok()).toBeTruthy();

  return request.storageState();
}

test.describe('auth session', () => {
  test('session persists across a full page reload', async ({ page }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId('nav-user')).toBeVisible();

    await page.reload({ timeout: 10000 });

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId('nav-user')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  });

  test('logout ends the session and protects authenticated routes', async ({
    request,
    browser,
    baseURL,
  }) => {
    test.setTimeout(90000);
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for mock auth tests');
    }

    const user = getSecondaryE2EUser();
    const context = await browser.newContext({
      storageState: await getIsolatedStorageState(request, user),
      baseURL,
    });
    await context.addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });
    const page = await context.newPage();

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await expect(page).not.toHaveURL(/\/login/);

      await page.getByTestId('nav-user').click();
      await page.getByRole('menuitem', { name: 'Log out' }).click();

      await page.waitForURL(/\/login/, { timeout: 10000 });
      await expect(page.getByLabel('Email')).toBeVisible();

      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await expect(page).toHaveURL(/\/login/);
    } finally {
      await context.close().catch(() => undefined);
      await cleanupUser(user);
    }
  });

  test('recovers from an expired bearer during app bootstrap without redirect looping', async ({
    page,
  }) => {
    test.setTimeout(30000);

    const expiredToken = createJwt(Date.now() - 60_000);
    const expiredBearerPaths: string[] = [];
    let refreshCalls = 0;

    await page.addInitScript(() => {
      const testWindow = window as AuthRecoveryTestWindow;
      testWindow.__authRecoveryTestEvents = [];
      window.addEventListener('authRecovery', (event) => {
        testWindow.__authRecoveryTestEvents.push({
          type: 'authRecovery',
          detail: (event as CustomEvent).detail,
        });
      });
      window.addEventListener('authRedirectStarted', (event) => {
        testWindow.__authRecoveryTestEvents.push({
          type: 'authRedirectStarted',
          detail: (event as CustomEvent).detail,
        });
      });
    });

    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;

      if (pathname === '/api/auth/refresh') {
        refreshCalls += 1;
        const response = await route.fetch();
        if (refreshCalls === 1) {
          const body = (await response.json()) as RefreshTokenBody;
          await route.fulfill({
            response,
            json: {
              ...body,
              token: expiredToken,
            },
          });
          return;
        }

        await route.fulfill({ response });
        return;
      }

      if (request.headers().authorization === `Bearer ${expiredToken}`) {
        expiredBearerPaths.push(pathname);
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          json: { message: 'jwt expired' },
        });
        return;
      }

      await route.continue();
    });

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    await expect.poll(() => refreshCalls).toBe(2);
    expect(expiredBearerPaths.length).toBeGreaterThan(0);

    const events = await page.evaluate(
      () => (window as AuthRecoveryTestWindow).__authRecoveryTestEvents,
    );

    expect(events.filter((event) => event.type === 'authRedirectStarted')).toHaveLength(0);
    expect(
      events.filter((event) => event.type === 'authRecovery').map((event) => event.detail),
    ).toEqual([{ state: 'started' }, { state: 'finished' }]);
  });
});
