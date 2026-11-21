import { ObjectId } from 'mongodb';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, TestInfo } from '@playwright/test';
import { createHarness } from './harness.cjs';

type AuthBody = {
  token?: string;
  refreshToken?: string;
  code?: string;
  error_code?: string;
  user?: { id?: string; _id?: string; email?: string };
};

let harness: Awaited<ReturnType<typeof createHarness>>;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  harness = await createHarness({ reuse: true, mode: 'enforce' });
});

test.afterAll(async () => {
  await harness?.close();
});

test.afterEach(async ({ browserName }, info) => {
  if (harness && info.status !== info.expectedStatus) {
    await info.attach(`${browserName}-redacted-app-log`, {
      body: await readFile(harness.logPath),
      contentType: 'text/plain',
    });
  }
  await harness?.gate.release();
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

async function evidence(info: TestInfo, name: string, value: object) {
  await info.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: 'application/json',
  });
}

async function credentials(context: BrowserContext) {
  const cookies = await context.cookies(harness.baseURL);
  return Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
}

async function sessionId(context: BrowserContext): Promise<string> {
  const cookies = await credentials(context);
  for (const name of ['openid_user_id', 'refreshToken']) {
    if (!cookies[name]) continue;
    const claims = JSON.parse(Buffer.from(cookies[name].split('.')[1], 'base64url').toString());
    if (claims.providerSession?.sid) return claims.providerSession.sid;
    if (claims.sessionId) {
      const session = await harness.db.collection('sessions').findOne({
        _id: new ObjectId(claims.sessionId),
      });
      if (session?.providerSession?.sid) return session.providerSession.sid;
    }
  }
  throw new Error('Login did not record a provider session');
}

async function login(browser: Browser, username: 'a' | 'b' = 'a', bound = true) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  contexts.push(context);
  const page = await harness.login(context, username);
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
  const sid = bound ? await sessionId(context) : undefined;
  // Close the page so UI requests cannot renew credentials during protocol assertions.
  await page.close();
  return { context, sid };
}

async function refresh(context: BrowserContext) {
  const response = await context.request
    .post(`${harness.baseURL}/api/auth/refresh`, {
      data: {},
      timeout: 30_000,
    })
    .catch(() => {
      // Playwright includes Cookie headers in transport error diagnostics.
      throw new Error('Authenticated refresh transport failed');
    });
  const body: AuthBody = await response.json();
  return { response, body };
}

async function adminRefresh(refreshToken: string, userId?: string) {
  const response = await fetch(`${harness.baseURL}/api/admin/oauth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken, user_id: userId, provider: 'openid' }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new Error('Admin renewal transport failed');
  });
  const body: AuthBody = await response.json();
  return { response, body };
}

async function revoke(sid: string) {
  await harness.admin(`/sessions/${encodeURIComponent(sid)}`, 'DELETE');
  await expect
    .poll(async () =>
      Boolean((await harness.db.collection('providersessions').findOne({ sid }))?.revokedAt),
    )
    .toBe(true);
}

function requireSid(sid: string | undefined): string {
  if (!sid) throw new Error('Expected a bound login');
  return sid;
}

test('real admin HTTP renewal preserves login attempts and stale-token recovery until logout', async ({
  browser,
}, info) => {
  await harness.startApp({ reuse: true, mode: 'enforce', loginMax: 7 });
  const { context, sid } = await login(browser, 'b');
  const original = (await credentials(context)).refreshToken;
  expect(Boolean(original)).toBe(true);
  const user = await harness.db
    .collection('users')
    .findOne({ email: 'b@example.test', provider: 'openid' });
  if (!user) throw new Error('Browser login did not create its user');
  const originalRole = user.role;
  const results: object[] = [];
  await harness.db.collection('users').updateOne({ _id: user._id }, { $set: { role: 'ADMIN' } });
  try {
    const request = () => adminRefresh(original, String(user._id));
    const accepted = async (label: string, result: Awaited<ReturnType<typeof request>>) => {
      results.push({ label, status: result.response.status, errorCode: result.body.error_code });
      expect(result.response.status).toBe(200);
      expect(typeof result.body.token).toBe('string');
      expect(typeof result.body.refreshToken).toBe('string');
      expect(String(result.body.user?.id ?? result.body.user?._id)).toBe(String(user._id));
      const verified = await fetch(`${harness.baseURL}/api/admin/verify`, {
        headers: { authorization: `Bearer ${result.body.token}` },
      });
      expect(verified.status).toBe(200);
    };

    const first = await request();
    await accepted('first rotation', first);
    expect(first.body.refreshToken !== original).toBe(true);
    // Keep sending the original token, as a client that lost the first reply would do.
    await accepted('lost response retry', await request());
    const concurrent = await Promise.all([request(), request()]);
    await accepted('concurrent left', concurrent[0]);
    await accepted('concurrent right', concurrent[1]);
    expect(concurrent[0].body.refreshToken === concurrent[1].body.refreshToken).toBe(true);
    for (let index = 0; index < 4; index++) {
      await accepted(`further renewal ${index + 1}`, await request());
    }
    // Eight renewals exceed LOGIN_MAX. A separate browser can still complete interactive login.
    await login(browser);
    results.push({ label: 'interactive login after eight renewals', accepted: true });
    expect(
      await harness.db
        .collection('refreshtokenbridges')
        .countDocuments({ 'providerSession.sid': sid }),
    ).toBeGreaterThan(0);

    await revoke(requireSid(sid));
    const denied = await request();
    results.push({
      label: 'after real Keycloak logout',
      status: denied.response.status,
      errorCode: denied.body.error_code,
    });
    expect(denied.response.status).toBe(401);
    expect(denied.body.error_code).toBe('OPENID_SESSION_ENDED');
    expect(Boolean(denied.body.token || denied.body.refreshToken)).toBe(false);
  } finally {
    await harness.db
      .collection('users')
      .updateOne(
        { _id: user._id },
        originalRole === undefined ? { $unset: { role: '' } } : { $set: { role: originalRole } },
      );
    await evidence(info, 'admin-http-results', {
      results,
      coverage:
        'Real admin HTTP routes with browser-issued OpenID credentials; no admin UI or code exchange.',
    });
    await harness.startApp({ loginMax: 1000 });
  }
});

test('a Keycloak outage keeps admin renewal retryable with the same credential', async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  await harness.startApp({ reuse: true, mode: 'enforce' });
  const { context } = await login(browser, 'b');
  const original = (await credentials(context)).refreshToken;
  expect(Boolean(original)).toBe(true);
  const user = await harness.db
    .collection('users')
    .findOne({ email: 'b@example.test', provider: 'openid' });
  if (!user) throw new Error('Browser login did not create its user');
  const originalRole = user.role;
  const sessionFilter = { refreshTokenHash: createHash('sha256').update(original).digest('hex') };
  expect(Boolean(await harness.db.collection('sessions').findOne(sessionFilter))).toBe(true);
  await harness.db.collection('users').updateOne({ _id: user._id }, { $set: { role: 'ADMIN' } });
  try {
    const flights = harness.db.collection('openidrefreshflights');
    const existingFlightIds = await flights.distinct('_id');
    await harness.stopKeycloak();
    try {
      const unavailable = await adminRefresh(original, String(user._id));
      expect(unavailable.response.status).toBe(503);
      expect(unavailable.body.error_code).toBe('AUTH_SESSION_CHECK_UNAVAILABLE');
      expect(Boolean(unavailable.body.token || unavailable.body.refreshToken)).toBe(false);
      expect(unavailable.response.headers.has('set-cookie')).toBe(false);
      expect(Boolean(await harness.db.collection('sessions').findOne(sessionFilter))).toBe(true);
      const pending = await flights
        .find(
          { _id: { $nin: existingFlightIds }, status: 'pending' },
          { projection: { lockExpiresAt: 1 } },
        )
        .toArray();
      expect(pending).toHaveLength(1);
      const [flight] = pending;
      expect(flight.lockExpiresAt).toBeInstanceOf(Date);
      expect(Number.isFinite(flight.lockExpiresAt.getTime())).toBe(true);
      // A failed grant keeps its lease. Retry after that lease expires.
      await expect
        .poll(
          async () => {
            const current = await flights.findOne(
              { _id: flight._id },
              { projection: { lockExpiresAt: 1 } },
            );
            return (
              current?.lockExpiresAt instanceof Date &&
              current.lockExpiresAt.getTime() <= Date.now()
            );
          },
          { timeout: 40_000 },
        )
        .toBe(true);
      await evidence(info, 'admin-provider-outage', {
        status: unavailable.response.status,
        errorCode: unavailable.body.error_code,
        credentialsIssued: false,
        sessionPreserved: true,
        grantLeaseExpired: true,
      });
    } finally {
      await harness.startKeycloak();
    }
    const recovered = await adminRefresh(original, String(user._id));
    expect(recovered.response.status).toBe(200);
    expect(typeof recovered.body.token).toBe('string');
    expect(typeof recovered.body.refreshToken).toBe('string');
    expect(recovered.body.refreshToken !== original).toBe(true);
    await evidence(info, 'admin-provider-recovery', {
      status: recovered.response.status,
      sameCredentialRetried: true,
      credentialRotated: true,
    });
  } finally {
    await harness.db
      .collection('users')
      .updateOne(
        { _id: user._id },
        originalRole === undefined ? { $unset: { role: '' } } : { $set: { role: originalRole } },
      );
  }
});

test('a real Keycloak invalid grant ends admin renewal while session checks are off', async ({
  browser,
}, info) => {
  await harness.startApp({ reuse: true, mode: 'enforce' });
  const { context, sid } = await login(browser);
  const original = (await credentials(context)).refreshToken;
  expect(Boolean(original)).toBe(true);
  await harness.startApp({ reuse: true, mode: 'off' });
  await harness.admin(`/sessions/${encodeURIComponent(requireSid(sid))}`, 'DELETE');
  await expect
    .poll(() => harness.deliveries.find((delivery) => delivery.sid === sid)?.status)
    .toBe(404);
  const binding = await harness.db.collection('providersessions').findOne({ sid });
  expect(Boolean(binding)).toBe(true);
  expect(Boolean(binding?.revokedAt)).toBe(false);

  const denied = await adminRefresh(original);
  expect(denied.response.status).toBe(401);
  expect(denied.body).toEqual({ error: 'Refresh failed', error_code: 'REFRESH_FAILED' });
  await evidence(info, 'admin-invalid-grant', {
    mode: 'off',
    logoutDeliveryStatus: 404,
    localBindingRevoked: false,
    status: denied.response.status,
    errorCode: denied.body.error_code,
  });
});

for (const reuse of [false, true]) {
  test(`duplicate logout, old SID replay, and restart preserve session isolation (reuse=${reuse})`, async ({
    browser,
  }, info) => {
    await harness.startApp({ reuse, mode: 'enforce' });
    const old = await login(browser);
    await revoke(requireSid(old.sid));
    const index = harness.deliveries.findIndex((delivery) => delivery.sid === old.sid);
    expect(index).toBeGreaterThanOrEqual(0);
    const before = await harness.db.collection('providersessions').findOne({ sid: old.sid });
    if (!before) throw new Error('Missing revoked provider session');
    expect((await harness.replay(index)).status).toBe(200);
    await harness.startApp({ reuse, mode: 'enforce' });
    const denied = await refresh(old.context);
    expect(denied.response.status()).toBe(401);
    expect(denied.body.code).toBe('OPENID_SESSION_ENDED');
    const fresh = await login(browser);
    expect(fresh.sid !== old.sid).toBe(true);
    expect((await harness.replay(index)).status).toBe(200);
    const after = await harness.db.collection('providersessions').findOne({ sid: old.sid });
    if (!after) throw new Error('Provider session disappeared after restart');
    expect(after.revokedAt.getTime()).toBe(before.revokedAt.getTime());
    expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(before.expiresAt.getTime());
    expect((await refresh(fresh.context)).response.status()).toBe(200);
    await evidence(info, 'duplicate-and-restart', {
      reuse,
      duplicateStatus: 200,
      revokedAfterRestart: true,
      freshSessionAccepted: true,
      revokedAtPreserved: true,
    });
  });
}

/** Flips the first signature byte, so header and claims stay valid and only the signature fails. */
function tamperSignature(token: string): string {
  const [header, payload, signature] = token.split('.');
  const bytes = Buffer.from(signature, 'base64url');
  bytes[0] ^= 0xff;
  return `${header}.${payload}.${bytes.toString('base64url')}`;
}

test('a logout token with a tampered signature is rejected and revokes nothing', async ({
  browser,
}, info) => {
  await harness.startApp({ reuse: false, mode: 'enforce' });
  const session = await login(browser);
  const sid = requireSid(session.sid);
  // Capture a real signed logout token without delivering it: the app is down when Keycloak sends it.
  await harness.stopApp();
  await harness.admin(`/sessions/${encodeURIComponent(sid)}`, 'DELETE');
  await expect
    .poll(() => harness.deliveries.findIndex((delivery) => delivery.sid === sid))
    .toBeGreaterThanOrEqual(0);
  const index = harness.deliveries.findIndex((delivery) => delivery.sid === sid);
  await expect.poll(() => harness.deliveries[index].status).toBeGreaterThanOrEqual(500);
  await harness.startApp({ reuse: false, mode: 'enforce' });

  const tampered = await harness.replay(index, tamperSignature);
  expect(tampered.status).toBe(400);
  expect(tampered.body).toEqual({ error: 'invalid_request' });
  const binding = await harness.db.collection('providersessions').findOne({ sid });
  expect(Boolean(binding)).toBe(true);
  expect(Boolean(binding?.revokedAt)).toBe(false);
  expect((await refresh(session.context)).response.status()).toBe(200);

  // The untampered token is accepted, so the rejection above came from the signature alone.
  expect((await harness.replay(index)).status).toBe(200);
  const denied = await refresh(session.context);
  expect(denied.response.status()).toBe(401);
  expect(denied.body.code).toBe('OPENID_SESSION_ENDED');
  await evidence(info, 'tampered-signature', {
    mode: 'enforce',
    tamperedStatus: tampered.status,
    revokedByTampered: false,
    refreshAfterTampered: 200,
    originalStatus: 200,
    deniedAfterOriginal: denied.body.code,
  });
});

for (const reuse of [false, true]) {
  test(`legacy credentials survive off and record, then require login in enforce (reuse=${reuse})`, async ({
    browser,
  }, info) => {
    await harness.startApp({ reuse, mode: 'off' });
    const legacy = await login(browser, 'a', false);
    const cookie = (await credentials(legacy.context)).refreshToken;
    const row = await harness.db
      .collection('sessions')
      .findOne({ refreshTokenHash: createHash('sha256').update(cookie).digest('hex') });
    if (!row) throw new Error('Legacy login did not create a session');
    expect(Boolean(row.providerSession)).toBe(false);
    const receiver = await legacy.context.request
      .post(`${harness.baseURL}/oauth/openid/backchannel-logout`, {
        form: { logout_token: 'invalid' },
        maxRedirects: 0,
      })
      .catch(() => {
        throw new Error('Disabled logout receiver transport failed');
      });
    expect(receiver.status()).toBe(404);
    expect((await refresh(legacy.context)).response.status()).toBe(200);
    await harness.startApp({ reuse, mode: 'record' });
    expect((await refresh(legacy.context)).response.status()).toBe(200);
    await harness.startApp({ reuse, mode: 'enforce' });
    const denied = await refresh(legacy.context);
    expect(denied.response.status()).toBe(401);
    expect(denied.body.code).toBe('OPENID_SESSION_ENDED');
    await evidence(info, 'legacy-mode-transition', {
      off: 200,
      record: 200,
      enforce: 401,
      code: denied.body.code,
      receiverOff: 404,
    });
  });
}

for (const finalMode of ['record', 'enforce'] as const) {
  test(`revoked local session rotates in off and remains revoked in ${finalMode}`, async ({
    browser,
  }, info) => {
    await harness.startApp({ reuse: false, mode: 'enforce' });
    const session = await login(browser);
    await revoke(requireSid(session.sid));
    const before = (await credentials(session.context)).refreshToken;
    await harness.startApp({ reuse: false, mode: 'off' });
    expect((await refresh(session.context)).response.status()).toBe(200);
    const after = (await credentials(session.context)).refreshToken;
    expect(after !== before).toBe(true);
    expect(await sessionId(session.context)).toBe(session.sid);
    expect(
      Boolean(
        (await harness.db.collection('providersessions').findOne({ sid: session.sid }))?.revokedAt,
      ),
    ).toBe(true);
    await harness.startApp({ reuse: false, mode: finalMode });
    const denied = await refresh(session.context);
    expect(denied.response.status()).toBe(401);
    expect(denied.body.code).toBe('OPENID_SESSION_ENDED');
    await evidence(info, 'revoked-mode-transition', {
      off: 200,
      rotated: true,
      bindingPreserved: true,
      finalMode,
      status: 401,
    });
  });
}

test('reuse token rotation in off preserves the binding for later enforcement @lifecycle', async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  await harness.startApp({ reuse: true, mode: 'enforce' });
  const session = await login(browser);
  const before = (await credentials(session.context)).refreshToken;
  // Let the real two-minute publication recovery window expire. Do not change stored auth state.
  await delay(125_000);
  await harness.startApp({ reuse: true, mode: 'off', maxSessionAgeMs: 0 });
  expect((await refresh(session.context)).response.status()).toBe(200);
  const after = (await credentials(session.context)).refreshToken;
  expect(after !== before).toBe(true);
  expect(await sessionId(session.context)).toBe(session.sid);
  await harness.startApp({ reuse: true, mode: 'enforce', maxSessionAgeMs: 300_000 });
  await revoke(requireSid(session.sid));
  const denied = await refresh(session.context);
  expect(denied.response.status()).toBe(401);
  expect(denied.body.code).toBe('OPENID_SESSION_ENDED');
  await evidence(info, 'reuse-off-rotation', {
    rotated: true,
    bindingPreserved: true,
    deniedAfterLogout: true,
  });
});

for (const reuse of [false, true]) {
  test(`database outage returns retryable 503, preserves cookies, and rejects logout persistence (reuse=${reuse}) @outage`, async ({
    browser,
  }, info) => {
    test.setTimeout(150_000);
    await harness.startApp({ reuse, mode: 'enforce' });
    const live = await login(browser);
    const revoked = await login(browser, 'b');
    const before = await credentials(live.context);
    await harness.gate.arm('authorize', live.sid);
    const pending = refresh(live.context);
    // Observe the pending request immediately so a failed gate cannot cause an unhandled rejection.
    void pending.catch(() => {});
    await harness.gate.wait();
    let logoutIndex = -1;
    try {
      await harness.stopMongo();
      await harness.gate.release();
      const unavailable = await pending;
      const failures = [unavailable];
      // This request fails at user/session lookup, before it can reach the authorization gate.
      if (!reuse) failures.push(await refresh(live.context));
      for (const failure of failures) {
        expect(failure.response.status()).toBe(503);
        expect(failure.body.code).toBe('AUTH_SESSION_CHECK_UNAVAILABLE');
        expect(
          failure.response
            .headersArray()
            .some(
              (header) =>
                header.name.toLowerCase() === 'set-cookie' &&
                /^(refreshToken|openid_user_id)=/.test(header.value),
            ),
        ).toBe(false);
      }
      const after = await credentials(live.context);
      expect(after.refreshToken === before.refreshToken).toBe(true);
      expect(after.openid_user_id === before.openid_user_id).toBe(true);
      expect(after['connect.sid'] === before['connect.sid']).toBe(true);
      expect(after.token_provider === before.token_provider).toBe(true);
      await harness.admin(`/sessions/${encodeURIComponent(requireSid(revoked.sid))}`, 'DELETE');
      await expect
        .poll(() => harness.deliveries.findIndex((delivery) => delivery.sid === revoked.sid))
        .toBeGreaterThanOrEqual(0);
      logoutIndex = harness.deliveries.findIndex((delivery) => delivery.sid === revoked.sid);
      await expect
        .poll(() => harness.deliveries[logoutIndex].status, { timeout: 30_000 })
        .toBe(503);
      const receiver = await harness.replay(logoutIndex);
      expect(receiver.status).toBe(503);
      expect(receiver.body).toEqual({ code: 'AUTH_SESSION_CHECK_UNAVAILABLE' });
      await evidence(info, 'database-outage', {
        refreshStatus: 503,
        refreshCode: unavailable.body.code,
        earlyLocalLookupStatus: failures[1]?.response.status(),
        cookiesPreserved: true,
        logoutStatus: harness.deliveries[logoutIndex].status,
        logoutCode: 'AUTH_SESSION_CHECK_UNAVAILABLE',
      });
    } finally {
      await harness.gate.release();
      await harness.startMongo();
    }
    await expect
      .poll(async () => (await refresh(live.context)).response.status(), { timeout: 20_000 })
      .toBe(200);
    expect((await harness.replay(logoutIndex)).status).toBe(200);
    const denied = await refresh(revoked.context);
    expect(denied.response.status()).toBe(401);
    expect(denied.body.code).toBe('OPENID_SESSION_ENDED');
  });
}

test('missed Keycloak delivery is measured and needs a later successful delivery @outage', async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  await harness.startApp({ reuse: false, mode: 'enforce' });
  const session = await login(browser);
  await harness.stopApp();
  const started = Date.now();
  await harness.admin(`/sessions/${encodeURIComponent(requireSid(session.sid))}`, 'DELETE');
  await expect
    .poll(() => harness.deliveries.filter((delivery) => delivery.sid === session.sid).length)
    .toBeGreaterThan(0);
  const firstIndex = harness.deliveries.findIndex((delivery) => delivery.sid === session.sid);
  await expect.poll(() => harness.deliveries[firstIndex].status).toBeGreaterThanOrEqual(500);
  await harness.startApp({ reuse: false, mode: 'enforce' });
  expect((await refresh(session.context)).response.status()).toBe(200);
  await delay(Math.max(0, 120_000 - (Date.now() - started)));
  const attempts = harness.deliveries.filter((delivery) => delivery.sid === session.sid);
  const row = await harness.db.collection('providersessions').findOne({ sid: session.sid });
  if (!row) throw new Error('Provider session disappeared during missed delivery');
  await evidence(info, 'missed-delivery-observation', {
    observationMs: Date.now() - started,
    attempts: attempts.map(({ at, status }) => ({ at, status })),
    revoked: Boolean(row.revokedAt),
    limitation:
      'This measures the pinned Keycloak image for 120 seconds. It does not promise an unlimited retry policy.',
  });
  expect(attempts.length).toBe(1);
  expect(Boolean(row.revokedAt)).toBe(false);
  expect((await refresh(session.context)).response.status()).toBe(200);
  expect((await harness.replay(firstIndex)).status).toBe(200);
  const denied = await refresh(session.context);
  expect(denied.response.status()).toBe(401);
  expect(denied.body.code).toBe('OPENID_SESSION_ENDED');
});
