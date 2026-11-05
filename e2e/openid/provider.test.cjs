const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { randomBytes, createHash } = require('node:crypto');
const { jwtVerify, decodeJwt, createLocalJWKSet } = require('jose');
const { startProvider, BACKCHANNEL_LOGOUT_EVENT } = require('./provider.cjs');

const APP_CLIENT = 'librechat-test';
const APP_CALLBACK_PATH = '/oauth/openid/callback';

function setCookie(response) {
  return response.headers.get('set-cookie').split(';')[0];
}

async function login(issuer, account) {
  const response = await fetch(`${issuer}/login?account=${account}`, { redirect: 'manual' });
  return setCookie(response);
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Drives the app's authorization-code request against the test provider, following its redirects. */
async function authorizeForApp(issuer, appUrl, cookie, { prompt, challenge } = {}) {
  const authorize = new URL(`${issuer}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: APP_CLIENT,
    redirect_uri: `${appUrl}${APP_CALLBACK_PATH}`,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state: randomBytes(16).toString('base64url'),
    nonce: randomBytes(16).toString('base64url'),
    ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
    ...(prompt ? { prompt } : {}),
  }).toString();
  const response = await fetch(authorize.href, {
    headers: cookie ? { Cookie: cookie } : {},
    redirect: 'manual',
  });
  return new URL(response.headers.get('location'), issuer);
}

async function tokenExchange(issuer, appUrl, { code, verifier, refreshToken }) {
  const body = new URLSearchParams({
    client_id: APP_CLIENT,
    client_secret: 'local-test-secret',
    ...(refreshToken
      ? { grant_type: 'refresh_token', refresh_token: refreshToken }
      : {
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${appUrl}${APP_CALLBACK_PATH}`,
          code_verifier: verifier,
        }),
  });
  const response = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  assert.equal(response.status, 200);
  return response.json();
}

/** Completes one login-code-token round trip for `account` and returns its id-token claims and refresh token. */
async function signInAndGetClaims(issuer, appUrl, account, options = {}) {
  const cookie = await login(issuer, account);
  const { verifier, challenge } = pkce();
  const destination = await authorizeForApp(issuer, appUrl, cookie, { challenge, ...options });
  const code = destination.searchParams.get('code');
  assert.ok(code, `expected an authorization code, got ${destination.href}`);
  const tokens = await tokenExchange(issuer, appUrl, { code, verifier });
  return { cookie, claims: decodeJwt(tokens.id_token), tokens };
}

function startStub() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      path: req.url,
      contentType: req.headers['content-type'],
      body: new URLSearchParams(Buffer.concat(chunks).toString()).get('logout_token'),
    });
    res.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  return { server, received };
}
async function stubUrl(server) {
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('id tokens carry a stable sid across a refresh grant', async () => {
  const fixture = await startProvider();
  try {
    const { claims, tokens } = await signInAndGetClaims(
      fixture.issuer,
      'http://localhost:3080',
      'A',
    );
    assert.equal(typeof claims.sid, 'string');
    assert.ok(claims.sid.length > 0);
    const refreshed = await tokenExchange(fixture.issuer, 'http://localhost:3080', {
      refreshToken: tokens.refresh_token,
    });
    assert.equal(decodeJwt(refreshed.id_token).sid, claims.sid);
  } finally {
    await fixture.close();
  }
});

test('prompt=login issues a new sid for the same account', async () => {
  const fixture = await startProvider();
  try {
    const first = await signInAndGetClaims(fixture.issuer, 'http://localhost:3080', 'A');
    const retryLogin = await authorizeForApp(
      fixture.issuer,
      'http://localhost:3080',
      first.cookie,
      {
        prompt: 'login',
      },
    );
    assert.ok(
      retryLogin.pathname === '/login',
      `expected a login redirect, got ${retryLogin.href}`,
    );
    const reauthUrl = new URL(retryLogin.href);
    reauthUrl.searchParams.set('account', 'A');
    const reauthenticated = await fetch(reauthUrl.href, { redirect: 'manual' });
    const newCookie = setCookie(reauthenticated);
    assert.notEqual(newCookie, first.cookie);
    const { verifier, challenge } = pkce();
    const destination = await authorizeForApp(fixture.issuer, 'http://localhost:3080', newCookie, {
      challenge,
    });
    const tokens = await tokenExchange(fixture.issuer, 'http://localhost:3080', {
      code: destination.searchParams.get('code'),
      verifier,
    });
    assert.notEqual(decodeJwt(tokens.id_token).sid, first.claims.sid);
  } finally {
    await fixture.close();
  }
});

test('logout tokens carry iss, aud, iat, exp, jti, sub, sid and the back-channel event, never a nonce', async () => {
  const fixture = await startProvider();
  try {
    const token = fixture.signLogoutToken('A', 'sid-123');
    const jwks = createLocalJWKSet(
      await fetch(`${fixture.issuer}/jwks`).then((response) => response.json()),
    );
    const { payload } = await jwtVerify(token, jwks, {
      issuer: fixture.issuer,
      audience: 'librechat-test',
    });
    assert.equal(payload.sub, 'A');
    assert.equal(payload.sid, 'sid-123');
    assert.equal(typeof payload.jti, 'string');
    assert.ok(payload.jti.length > 0);
    assert.equal(typeof payload.iat, 'number');
    assert.equal(typeof payload.exp, 'number');
    assert.deepEqual(payload.events, { [BACKCHANNEL_LOGOUT_EVENT]: {} });
    assert.equal(payload.nonce, undefined);
  } finally {
    await fixture.close();
  }
});

test('console sign-out ends the provider session and delivers the logout token once', async () => {
  const stub = startStub();
  const appUrl = await stubUrl(stub.server);
  const fixture = await startProvider({ appUrl });
  try {
    const { cookie, claims } = await signInAndGetClaims(fixture.issuer, appUrl, 'A');
    const signout = await fetch(`${fixture.issuer}/console/signout`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(signout.status, 302);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stub.received.length, 1);
    const delivered = decodeJwt(stub.received[0].body);
    assert.equal(delivered.sub, 'A');
    assert.equal(delivered.sid, claims.sid);
    assert.equal(stub.received[0].contentType, 'application/x-www-form-urlencoded');

    const authorizeAgain = await authorizeForApp(fixture.issuer, appUrl, cookie, {});
    assert.equal(authorizeAgain.pathname, '/login', 'the provider session must no longer resolve');
  } finally {
    await fixture.close();
    stub.server.close();
  }
});

test('a delayed console sign-out delivers the logout token after the requested delay', async () => {
  const stub = startStub();
  const appUrl = await stubUrl(stub.server);
  const fixture = await startProvider({ appUrl });
  try {
    const { cookie } = await signInAndGetClaims(fixture.issuer, appUrl, 'A');
    const startedAt = Date.now();
    await fetch(`${fixture.issuer}/console/signout?delayMs=300`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.ok(Date.now() - startedAt < 250, 'the sign-out response must not block on delivery');
    assert.equal(stub.received.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(stub.received.length, 1);
  } finally {
    await fixture.close();
    stub.server.close();
  }
});

test('issuerTrailingSlash puts a trailing slash on the discovery issuer and every token iss, while endpoints keep routing on the bare issuer', async () => {
  const stub = startStub();
  const appUrl = await stubUrl(stub.server);
  const fixture = await startProvider({ appUrl, issuerTrailingSlash: true });
  try {
    const discovery = await fetch(`${fixture.issuer}/.well-known/openid-configuration`).then(
      (response) => response.json(),
    );
    assert.equal(discovery.issuer, `${fixture.issuer}/`);
    assert.equal(discovery.authorization_endpoint, `${fixture.issuer}/authorize`);

    const { cookie, claims } = await signInAndGetClaims(fixture.issuer, appUrl, 'A');
    assert.equal(claims.iss, `${fixture.issuer}/`);

    const signout = await fetch(`${fixture.issuer}/console/signout`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(signout.status, 302);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stub.received.length, 1);
    const delivered = decodeJwt(stub.received[0].body);
    assert.equal(delivered.iss, `${fixture.issuer}/`);
    assert.equal(delivered.sid, claims.sid);
  } finally {
    await fixture.close();
    stub.server.close();
  }
});

test('a duplicate console sign-out delivers the same logout token twice', async () => {
  const stub = startStub();
  const appUrl = await stubUrl(stub.server);
  const fixture = await startProvider({ appUrl });
  try {
    const { cookie } = await signInAndGetClaims(fixture.issuer, appUrl, 'A');
    await fetch(`${fixture.issuer}/console/signout?duplicate=true`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(stub.received.length, 2);
    assert.equal(stub.received[0].body, stub.received[1].body);
  } finally {
    await fixture.close();
    stub.server.close();
  }
});
