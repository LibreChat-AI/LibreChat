import { ObjectId } from 'mongodb';
import { createServer } from 'node:net';
import { test as base, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';
import { createHarness } from './harness.cjs';

type Harness = Awaited<ReturnType<typeof createHarness>>;
type Claims = { exp?: number; sid?: string; sessionId?: string; providerSession?: { sid: string } };
type RefreshBody = { code?: string; token?: string; user?: { email: string } };

const test = base.extend<
  { contexts: BrowserContext[]; nativeContext: BrowserContext },
  { harness: Harness }
>({
  harness: [
    // Playwright requires a destructured fixture dependency parameter.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const harness = await createHarness({ reuse: true, mode: 'enforce' });
      try {
        await provide(harness);
      } finally {
        await harness.close();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  nativeContext: async ({ playwright, headless }, provide) => {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('Could not reserve a browser port');
    const port = address.port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    // The normal Playwright context forces visible/focused state on every page.
    // A separate default context without these overrides exposes real tab visibility.
    const owner = await playwright.chromium.launch({
      headless,
      channel: 'chromium',
      args: [`--remote-debugging-port=${port}`, '--ignore-certificate-errors'],
    });
    let attached: Browser | undefined;
    try {
      const identity = await owner.newBrowserCDPSession();
      const { targetId } = await identity.send('Target.createTarget', { url: 'about:blank' });
      const targets: Array<{ id: string }> = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) })
      ).json();
      if (!targets.some((target) => target.id === targetId)) {
        throw new Error('The debug endpoint does not belong to the disposable browser');
      }
      await identity.send('Target.closeTarget', { targetId });
      await identity.detach();
      attached = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        noDefaults: true,
      });
      await provide(attached.contexts()[0]);
    } finally {
      try {
        await attached?.close();
      } finally {
        await owner.close();
      }
    }
  },
  // eslint-disable-next-line no-empty-pattern
  contexts: async ({}, provide) => {
    const contexts: BrowserContext[] = [];
    try {
      await provide(contexts);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
});

function claims(value: string): Claims {
  return JSON.parse(Buffer.from(decodeURIComponent(value).split('.')[1], 'base64url').toString());
}

async function sessionId(harness: Harness, context: BrowserContext): Promise<string> {
  for (const cookie of await context.cookies(harness.baseURL)) {
    let payload: Claims;
    try {
      payload = claims(cookie.value);
    } catch {
      continue;
    }
    if (payload.providerSession?.sid) return payload.providerSession.sid;
    if (payload.sid) return payload.sid;
    if (payload.sessionId) {
      const session = await harness.db.collection('sessions').findOne({
        _id: new ObjectId(payload.sessionId),
      });
      if (session?.providerSession?.sid) return session.providerSession.sid;
    }
  }
  throw new Error('Login did not establish a provider-session binding');
}

async function enterAccount(page: Page, account = 'a') {
  await page.getByLabel('Username or email').fill(account);
  await page.getByLabel('Password', { exact: true }).fill('local-test-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
}

async function login(harness: Harness, context: BrowserContext, account = 'a') {
  const page = await context.newPage();
  await page.goto(`${harness.baseURL}/oauth/openid`);
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/refresh' && response.status() === 200,
  );
  await enterAccount(page, account);
  const body: RefreshBody = await (await refreshed).json();
  expect(body.user?.email).toBe(`${account}@example.test`);
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
  return { page, sid: await sessionId(harness, context), body };
}

async function revoke(harness: Harness, sid: string) {
  await harness.admin(`/sessions/${encodeURIComponent(sid)}`, 'DELETE');
  await expect
    .poll(async () =>
      Boolean((await harness.db.collection('providersessions').findOne({ sid }))?.revokedAt),
    )
    .toBe(true);
}

async function logoutAtProvider(harness: Harness, context: BrowserContext, sid: string) {
  const provider = await context.newPage();
  try {
    await provider.goto(
      `${harness.issuer}/protocol/openid-connect/logout?client_id=librechat-test`,
    );
    await provider.getByRole('button', { name: 'Logout', exact: true }).click();
    await expect(
      provider.getByRole('heading', { name: 'You are logged out', exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        Boolean((await harness.db.collection('providersessions').findOne({ sid }))?.revokedAt),
      )
      .toBe(true);
  } finally {
    await provider.close();
  }
}

async function refresh(harness: Harness, context: BrowserContext) {
  const response = await context.request
    .post(`${harness.baseURL}/api/auth/refresh`, { data: {} })
    .catch(() => {
      throw new Error('The authenticated refresh request failed');
    });
  const body: RefreshBody = await response.json();
  return { response, body };
}

function expectEnded(result: Awaited<ReturnType<typeof refresh>>) {
  expect(result.response.status()).toBe(401);
  expect(result.body.code).toBe('OPENID_SESSION_ENDED');
  expect(Boolean(result.body.token)).toBe(false);
  expect(
    result.response
      .headersArray()
      .some(
        (header) =>
          header.name.toLowerCase() === 'set-cookie' &&
          /^(refreshToken|openid_user_id|token_provider)=/.test(header.value),
      ),
  ).toBe(false);
}

async function credentialCookies(context: BrowserContext, baseURL: string) {
  return Object.fromEntries(
    (await context.cookies(baseURL))
      .filter((cookie) => ['refreshToken', 'openid_user_id'].includes(cookie.name))
      .map((cookie) => [cookie.name, cookie.value]),
  );
}

for (const reuse of [true, false]) {
  test.describe(`browser ${reuse ? 'provider' : 'local'} tokens`, () => {
    test.beforeEach(async ({ harness }) => {
      await harness.startApp({ reuse, mode: 'enforce' });
    });

    test('revoking one SID leaves another browser session for the same user working', async ({
      browser,
      contexts,
      harness,
    }) => {
      const first = await browser.newContext({ ignoreHTTPSErrors: true });
      const second = await browser.newContext({ ignoreHTTPSErrors: true });
      contexts.push(first, second);
      const a = await login(harness, first);
      const b = await login(harness, second);
      expect(a.sid !== b.sid).toBe(true);
      await revoke(harness, a.sid);
      expectEnded(await refresh(harness, first));
      const surviving = await refresh(harness, second);
      expect(surviving.response.status()).toBe(200);
      expect(surviving.body.user?.email).toBe('a@example.test');
      await b.page.reload();
      await expect(b.page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
    });

    test('a delayed denial from A does not clear credentials after B signs in', async ({
      browser,
      contexts,
      harness,
    }) => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      contexts.push(context);
      const a = await login(harness, context);
      await revoke(harness, a.sid);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let captured!: (body: RefreshBody) => void;
      const received = new Promise<RefreshBody>((resolve) => (captured = resolve));
      const handler = async (route: Route) => {
        const response = await route.fetch().catch(() => {
          throw new Error('The controlled refresh request failed');
        });
        captured(await response.json());
        await released;
        await route.fulfill({ response }).catch(() => {
          throw new Error('The controlled refresh response could not be delivered');
        });
      };
      await a.page.route('**/api/auth/refresh', handler, { times: 1 });
      try {
        await a.page.reload({ waitUntil: 'domcontentloaded' });
        expect((await received).code).toBe('OPENID_SESSION_ENDED');
        const b = await login(harness, context, 'b');
        const before = await credentialCookies(context, harness.baseURL);
        expect(Boolean(before.refreshToken)).toBe(true);
        release();
        await expect(a.page).toHaveURL(/\/login(?:[/?]|$)/);
        const after = await credentialCookies(context, harness.baseURL);
        // Compare booleans so a failed assertion cannot print credentials.
        expect(after.refreshToken === before.refreshToken).toBe(true);
        expect(after.openid_user_id === before.openid_user_id).toBe(true);
        expect((await refresh(harness, context)).body.user?.email).toBe('b@example.test');
        await expect(b.page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
      } finally {
        release();
        await a.page.unrouteAll({ behavior: 'wait' });
      }
    });

    test('logout before callback binding prevents credentials from being issued', async ({
      browser,
      contexts,
      harness,
    }) => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(`${harness.baseURL}/oauth/openid`);
      await page.getByLabel('Username or email').fill('a');
      await page.getByLabel('Password', { exact: true }).fill('local-test-password');
      await harness.gate.arm('establish');
      try {
        await page
          .getByRole('button', { name: 'Sign In', exact: true })
          .click({ noWaitAfter: true });
        const held = await harness.gate.wait();
        await revoke(harness, held.sid);
        await harness.gate.release();
        await expect(page).toHaveURL(/OPENID_SESSION_ENDED/);
        expect(Boolean((await credentialCookies(context, harness.baseURL)).refreshToken)).toBe(
          false,
        );
      } finally {
        await harness.gate.release();
      }
    });

    test('logout during renewal denies the waiting refresh without issuing credentials', async ({
      browser,
      contexts,
      harness,
    }) => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      contexts.push(context);
      const signedIn = await login(harness, context);
      await signedIn.page.close();
      await harness.gate.arm('authorize');
      const pending = refresh(harness, context);
      try {
        const held = await harness.gate.wait();
        expect(held.sid === signedIn.sid).toBe(true);
        await revoke(harness, signedIn.sid);
        await harness.gate.release();
        expectEnded(await pending);
      } finally {
        await harness.gate.release();
        await pending.catch(() => undefined);
      }
    });
  });
}

test('a missing connect.sid recovers a live session but cannot recover a revoked session', async ({
  browser,
  contexts,
  harness,
}) => {
  await harness.startApp({ reuse: true, mode: 'enforce' });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(context);
  const signedIn = await login(harness, context);
  await signedIn.page.close();
  await context.clearCookies({ name: 'connect.sid' });
  const recovered = await refresh(harness, context);
  expect(recovered.response.status()).toBe(200);
  expect(recovered.body.user?.email).toBe('a@example.test');
  expect(await sessionId(harness, context)).toBe(signedIn.sid);
  await revoke(harness, signedIn.sid);
  await context.clearCookies({ name: 'connect.sid' });
  expectEnded(await refresh(harness, context));
});

for (const background of [false, true]) {
  test(`an open ${background ? 'background' : 'foreground'} tab signs out on request-triggered renewal`, async ({
    nativeContext: context,
    harness,
  }, testInfo) => {
    await harness.startApp({ reuse: true, mode: 'enforce' });
    const { page, sid, body } = await login(harness, context);
    await page.goto(`${harness.baseURL}/projects`);
    await page.getByRole('button', { name: 'New project', exact: true }).first().click();
    await page
      .getByRole('textbox', { name: 'Project name', exact: true })
      .fill('Logout renewal test');
    expect(Boolean(body.token)).toBe(true);
    const expiry = claims(body.token!).exp;
    expect(typeof expiry).toBe('number');
    await logoutAtProvider(harness, context, sid);
    await page.bringToFront();
    const projectWrites: number[] = [];
    page.on('response', (response) => {
      if (
        new URL(response.url()).pathname === '/api/projects' &&
        response.request().method() === 'POST'
      ) {
        projectWrites.push(response.status());
      }
    });
    let deniedBody: RefreshBody | undefined;
    await page.route(
      '**/api/auth/refresh',
      async (route) => {
        const response = await route.fetch().catch(() => {
          throw new Error('The controlled refresh request failed');
        });
        deniedBody = await response.json();
        await route.fulfill({ response }).catch(() => {
          throw new Error('The controlled refresh response could not be delivered');
        });
      },
      { times: 1 },
    );
    await harness.gate.arm('authorize');
    const denied = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/refresh' && response.status() === 401,
    );
    void denied.catch(() => undefined);
    // Only the browser clock moves. The token and provider keep their real expiry.
    await page.clock.setFixedTime(new Date((expiry! - 60) * 1000));
    const action = page
      .getByRole('button', { name: 'Create project', exact: true })
      .click({ noWaitAfter: true });
    void action.catch(() => undefined);
    try {
      await harness.gate.wait();
      if (background) {
        const opened = context.waitForEvent('page');
        await page.evaluate(() => window.open('about:blank', '_blank'));
        const other = await opened;
        await other.waitForLoadState();
        await other.bringToFront();
        await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
      }
      const visibility = await page.evaluate(() => ({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      }));
      await testInfo.attach('renewal-tab-state', {
        body: JSON.stringify({ backgroundRequested: background, ...visibility }),
        contentType: 'application/json',
      });
      await harness.gate.release();
      await denied;
      await action;
      expect(deniedBody?.code).toBe('OPENID_SESSION_ENDED');
      await expect(page).toHaveURL(/\/login(?:[/?]|$)/);
      await expect(page.getByRole('textbox', { name: 'Message input' })).toBeHidden();
      expect(projectWrites).toEqual([]);
    } finally {
      await harness.gate.release();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
  });
}
