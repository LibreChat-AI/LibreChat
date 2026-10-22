import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const issuer = 'https://127.0.0.1:4400';
async function consoleLogin(page: Page, account: 'A' | 'B') {
  await page.goto(`${issuer}/console/login?account=${account}`);
  await expect(page.getByText(`Provider account: ${account}`, { exact: true })).toBeVisible();
}
async function signInAgent(page: Page) {
  const refreshed = page.waitForResponse(
    async (response) =>
      response.url().endsWith('/api/auth/refresh') &&
      response.status() === 200 &&
      response.headers()['content-type']?.includes('application/json') === true &&
      (await response.json()).user?.email === 'a@example.test',
  );
  await page.goto('/');
  await refreshed;
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
}

async function reloadVerified(page: Page, destination?: string) {
  const completed = page.waitForResponse((response) =>
    response.url().endsWith('/api/auth/openid/session-check/complete'),
  );
  const refreshed = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/refresh') && response.status() === 200,
  );
  if (destination) await page.goto(destination);
  else await page.reload();
  expect(await (await completed).json()).toEqual({ status: 'verified' });
  expect((await (await refreshed).json()).user.email).toBe('a@example.test');
}

test.beforeEach(async ({ request }) => {
  await request.get(`${issuer}/test/failure`);
});

test('reload verifies the same identity; Console logout prevents restoring it', async ({
  page,
  context,
}) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  await signInAgent(page);
  await reloadVerified(page);
  await reloadVerified(page);
  await consolePage.goto(`${issuer}/logout`);
  const privateRequests: string[] = [];
  let reloading = false;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) reloading = true;
    if (reloading && /\/api\/(auth\/refresh|user|convos)/.test(request.url()))
      privateRequests.push(request.url());
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue to sign in' })).toBeVisible();
  expect(privateRequests).toEqual([]);
});

test('switching accounts ends A and waits for Continue before signing in B', async ({
  page,
  context,
}) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  await signInAgent(page);
  await consolePage.goto(`${issuer}/logout`);
  await consoleLogin(consolePage, 'B');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue to sign in' })).toBeVisible();
  const refreshed = page.waitForResponse(
    (response) => response.url().includes('/api/auth/refresh') && response.status() === 200,
  );
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  expect((await (await refreshed).json()).user.email).toBe('b@example.test');
});

test('interaction required waits for Continue; provider errors offer Retry', async ({
  page,
  context,
}) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  await signInAgent(page);
  await page.goto('about:blank');
  await context.clearCookies({ name: 'connect.sid' });
  await consolePage.goto(`${issuer}/test/failure?error=interaction_required`);
  await page.goto('/c/new');
  await expect(page.getByRole('button', { name: 'Continue to sign in' })).toBeVisible();
  await consolePage.goto(`${issuer}/test/failure?error=server_error`);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
});

test('two simultaneous reloads keep separate authorization transactions', async ({
  page,
  context,
}) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  await signInAgent(page);
  const other = await context.newPage();
  await signInAgent(other);
  await Promise.all([reloadVerified(page), reloadVerified(other)]);
});

test('a direct link survives the check and public shares do not start a check', async ({
  page,
  context,
}) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  await signInAgent(page);
  const restored = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/refresh') && response.status() === 200,
  );
  await page.goto('/c/new?session-check-test=1#message');
  await restored;
  await expect(page).toHaveURL(/\/c\/new\?session-check-test=1#message$/);
  const checks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/openid/session-check')) checks.push(request.url());
  });
  await page.goto('/share/missing-public-share');
  await expect(page.getByRole('main')).toBeVisible();
  expect(checks).toEqual([]);
});

for (const account of ['same', 'missing', 'different'] as const) {
  test(`server-session expiry checks the provider identity: ${account}`, async ({
    page,
    context,
  }) => {
    const consolePage = await context.newPage();
    await consoleLogin(consolePage, 'A');
    await signInAgent(page);
    await page.goto('about:blank');
    await context.clearCookies({ name: 'connect.sid' });
    if (account === 'same') {
      await reloadVerified(page, '/c/new');
      await page.goto('about:blank');
      await context.clearCookies({ name: 'connect.sid' });
      await reloadVerified(page, '/c/new');
      return;
    }
    await consolePage.goto(`${issuer}/logout`);
    if (account === 'different') await consoleLogin(consolePage, 'B');
    const privateRequests: string[] = [];
    let reloading = false;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) reloading = true;
      if (reloading && /\/api\/(auth\/refresh|user|convos)/.test(request.url()))
        privateRequests.push(request.url());
    });
    await page.goto('/c/new');
    await expect(page.getByRole('button', { name: 'Continue to sign in' })).toBeVisible();
    expect(privateRequests).toEqual([]);
    if (account === 'different') {
      const refreshed = page.waitForResponse(
        (response) => response.url().endsWith('/api/auth/refresh') && response.status() === 200,
      );
      await page.getByRole('button', { name: 'Continue to sign in' }).click();
      expect((await (await refreshed).json()).user.email).toBe('b@example.test');
    }
  });
}

test('cookie recovery cannot restore a retired refresh chain', async ({ page, context }) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  await signInAgent(page);
  const oldCookies = (await context.cookies('http://localhost:3080')).filter((cookie) =>
    ['token_provider', 'openid_user_id', 'refreshToken'].includes(cookie.name),
  );
  expect(oldCookies).toHaveLength(3);
  await consolePage.goto(`${issuer}/logout`);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue to sign in' })).toBeVisible();
  await consoleLogin(consolePage, 'A');
  await context.clearCookies({ name: 'connect.sid' });
  await context.addCookies(oldCookies);
  const refresh = page.waitForResponse((response) => response.url().endsWith('/api/auth/refresh'));
  await page.reload();
  expect((await refresh).status()).toBeGreaterThanOrEqual(400);
});
