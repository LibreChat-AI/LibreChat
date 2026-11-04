import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

const issuer = 'https://127.0.0.1:4400';

async function consoleLogin(page: Page, account: 'A' | 'B') {
  await page.goto(`${issuer}/console/login?account=${account}`);
  await expect(page.getByText(`Provider account: ${account}`, { exact: true })).toBeVisible();
}

/** Signs the main tab in through the OpenID flow and returns the bearer the app issued. */
async function signInAgent(page: Page, email = 'a@example.test'): Promise<string> {
  const refreshed = page.waitForResponse(async (response) => {
    if (!response.url().endsWith('/api/auth/refresh') || response.status() !== 200) return false;
    try {
      const body = await response.json();
      return typeof body.token === 'string' && body.user?.email === email;
    } catch {
      return false;
    }
  });
  await page.goto('/');
  const token = (await (await refreshed).json()).token as string;
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
  return token;
}

async function agentsApiStatus(request: APIRequestContext, token: string): Promise<number> {
  const response = await request.get('/api/agents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.status();
}

/** Reloads and waits for the denied refresh, unless the app's background poll already
 *  navigated to `/login`; tolerates a reload that errors because it got there first. */
async function expectSignedOut(page: Page) {
  if (!/\/login(?:[/?]|$)/.test(page.url())) {
    const denied = page
      .waitForResponse(
        (response) => response.url().endsWith('/api/auth/refresh') && response.status() >= 400,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
    await page.reload().catch(() => undefined);
    await denied;
  }
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).not.toBeVisible();
  await expect(page).toHaveURL(/\/login(?:[/?]|$)/, { timeout: 30_000 });
}

async function consoleSignOut(
  consolePage: Page,
  options: { delayMs?: number; duplicate?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.delayMs) params.set('delayMs', String(options.delayMs));
  if (options.duplicate) params.set('duplicate', 'true');
  const query = params.toString();
  await consolePage.goto(`${issuer}/console/signout${query ? `?${query}` : ''}`);
}

async function signInAsB(page: Page) {
  await expect(page).toHaveURL(/\/login(?:[/?]|$)/, { timeout: 30_000 });
  await page.getByRole('link', { name: 'Sign in as B' }).click();
  await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 });
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
}

test('console sign-out revokes the bearer and reload shows the login page', async ({
  page,
  context,
}) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  const token = await signInAgent(page);
  expect(await agentsApiStatus(context.request, token)).toBe(200);

  await consoleSignOut(consolePage);

  await expect.poll(() => agentsApiStatus(context.request, token), { timeout: 15_000 }).toBe(401);
  await expectSignedOut(page);
});

test('signing in as a different account succeeds after a console sign-out', async ({
  page,
  context,
}) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  await signInAgent(page);
  await consoleSignOut(consolePage);
  await expectSignedOut(page);
  await signInAsB(page);
});

test('a delayed back-channel delivery still revokes the bearer', async ({ page, context }) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  const token = await signInAgent(page);

  await consoleSignOut(consolePage, { delayMs: 3_000 });
  expect(await agentsApiStatus(context.request, token)).toBe(200);

  await expect.poll(() => agentsApiStatus(context.request, token), { timeout: 15_000 }).toBe(401);
  await expectSignedOut(page);
});

test('a duplicate back-channel delivery is harmless', async ({ page, context }) => {
  const consolePage = await context.newPage();
  await consoleLogin(consolePage, 'A');
  const token = await signInAgent(page);

  await consoleSignOut(consolePage, { duplicate: true });

  await expect.poll(() => agentsApiStatus(context.request, token), { timeout: 15_000 }).toBe(401);
  await expectSignedOut(page);
});

test('a console sign-out in one browser logs out a second browser on the same subject', async ({
  browser,
}) => {
  const contextA = await browser.newContext({ ignoreHTTPSErrors: true });
  const contextB = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const pageA = await contextA.newPage();
    const consoleA = await contextA.newPage();
    await consoleLogin(consoleA, 'A');
    const tokenA = await signInAgent(pageA);

    const pageB = await contextB.newPage();
    const consoleB = await contextB.newPage();
    await consoleLogin(consoleB, 'A');
    const tokenB = await signInAgent(pageB);

    await consoleSignOut(consoleA);

    await expect
      .poll(() => agentsApiStatus(contextA.request, tokenA), { timeout: 15_000 })
      .toBe(401);
    await expect
      .poll(() => agentsApiStatus(contextB.request, tokenB), { timeout: 15_000 })
      .toBe(401);
    await expectSignedOut(pageA);
    await expectSignedOut(pageB);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
