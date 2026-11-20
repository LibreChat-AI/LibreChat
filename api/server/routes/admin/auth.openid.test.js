const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const session = require('express-session');

const ISSUER = 'https://idp.example.com';
const ADMIN_PANEL_URL = 'https://admin.example.com';
const CLIENT_ID = 'librechat-admin';
const SUBJECT = 'entra-subject-1';
const EMAIL = 'admin@example.com';

process.env.DOMAIN_SERVER = 'https://librechat.example.com';
process.env.DOMAIN_CLIENT = 'https://librechat.example.com';
process.env.ADMIN_PANEL_URL = ADMIN_PANEL_URL;

/**
 * Jest maps `openid-client` to a stub for the rest of the suite; this file runs the installed
 * library so the Passport strategy's own state and nonce handling is what the routes exercise.
 */
const mockInstalledOpenIdClient = (subpath) => {
  const manifest = require.resolve('openid-client/package.json');
  return path.join(path.dirname(manifest), require(manifest).exports[subpath].default);
};
const mockIdpFetch = jest.fn();
const mockCaches = new Map();
const mockAdminUser = {
  _id: 'admin-user-id',
  email: EMAIL,
  name: 'Entra Admin',
  username: 'entra-admin',
  role: 'ADMIN',
  provider: 'openid',
  openidId: SUBJECT,
  openidIssuer: ISSUER,
};

jest.mock('openid-client', () => jest.requireActual(mockInstalledOpenIdClient('.')));
jest.mock('openid-client/passport', () =>
  jest.requireActual(mockInstalledOpenIdClient('./passport')),
);
jest.mock('undici', () => ({
  ...jest.requireActual('undici'),
  fetch: (...args) => mockIdpFetch(...args),
}));
jest.mock('~/cache/getLogStores', () =>
  jest.fn((namespace) => {
    if (!mockCaches.has(namespace)) {
      const { Keyv: MockKeyv } = jest.requireActual('keyv');
      mockCaches.set(namespace, new MockKeyv());
    }
    return mockCaches.get(namespace);
  }),
);
jest.mock('~/models', () => ({
  findUser: jest.fn(async () => ({ ...mockAdminUser })),
  updateUser: jest.fn(async (_id, user) => user),
  findRolesByNames: jest.fn(async () => []),
  findBalanceByUser: jest.fn(),
  recordAuditEntry: jest.fn(),
  createUserIfAbsent: jest.fn(),
  findUsers: jest.fn(),
  getUserById: jest.fn(),
  upsertBalanceFields: jest.fn(),
  generateToken: jest.fn(async () => 'admin-session-token'),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({})),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));
jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn(),
}));
jest.mock('~/server/services/PermissionService', () => ({
  syncUserEntraGroupMemberships: jest.fn(),
}));
jest.mock('~/server/services/AuthService', () => ({
  setAuthTokens: jest.fn(),
}));
jest.mock('~/server/services/OpenIDRefreshRecovery', () => ({
  sendOpenIDAuthResponse: jest.fn(),
}));
jest.mock('~/server/controllers/auth/LoginController', () => ({
  loginController: jest.fn(),
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(async () => true),
  requireCapability: jest.fn(() => (req, res, next) => next()),
}));
jest.mock('~/server/middleware', () => {
  const pass = (req, res, next) => next();
  return {
    logHeaders: pass,
    requireSameOrigin: pass,
    loginLimiter: pass,
    validateEmailLogin: pass,
    requireLocalAuth: pass,
    requireJwtAuth: pass,
    checkDomainAllowed: pass,
    checkBan: jest.fn(async () => undefined),
  };
});

const passport = require('passport');
const { CacheKeys } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { setupOpenId } = require('~/strategies/openidStrategy');
const adminAuthRouter = require('./auth');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

/** Discovery documents for an IdP that advertises S256 (Keycloak) and one that does not (Entra ID). */
const discovery = (codeChallengeMethods) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  jwks_uri: `${ISSUER}/jwks`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  ...(codeChallengeMethods ? { code_challenge_methods_supported: codeChallengeMethods } : {}),
});

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signIdToken(claims) {
  const input = `${base64url({ alg: 'RS256', typ: 'JWT', kid: 'idp-key' })}.${base64url(claims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A minimal IdP behind `undici.fetch`: discovery, a PKCE-checking token endpoint and userinfo.
 * The ID token echoes the authorization request's nonce unless `idTokenNonce` is set: `null`
 * leaves the claim out and a string replaces it.
 */
function createIdp(metadata) {
  const idp = { authorization: null, idTokenNonce: undefined };

  idp.authorize = (location) => {
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(metadata.authorization_endpoint);
    idp.authorization = Object.fromEntries(url.searchParams);
    return { code: 'idp-authorization-code', state: idp.authorization.state };
  };

  mockIdpFetch.mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(metadata);
    }
    if (url.pathname === '/userinfo') {
      return json({ sub: SUBJECT, email: EMAIL });
    }
    if (url.pathname !== '/token') {
      return json({ error: 'not_found' }, 404);
    }

    const body = new URLSearchParams(init.body);
    const verifierChallenge = crypto
      .createHash('sha256')
      .update(body.get('code_verifier') ?? '')
      .digest('base64url');
    if (
      body.get('code') !== 'idp-authorization-code' ||
      verifierChallenge !== idp.authorization?.code_challenge
    ) {
      return json({ error: 'invalid_grant' }, 400);
    }

    const now = Math.floor(Date.now() / 1000);
    const nonce = idp.idTokenNonce === undefined ? idp.authorization.nonce : idp.idTokenNonce;
    return json({
      access_token: 'idp-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: signIdToken({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: SUBJECT,
        email: EMAIL,
        iat: now,
        exp: now + 3600,
        ...(nonce ? { nonce } : {}),
      }),
    });
  });

  return idp;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'openid-session-secret', resave: false, saveUninitialized: false }));
  app.get('/oauth/openid', passport.authenticate('openid', { session: false }));
  app.use('/api/admin', adminAuthRouter);
  return app;
}

/** Runs the admin panel's OpenID sign-in up to the exchange code it receives on its callback. */
async function signIn(app, idp, codeChallenge) {
  const agent = request.agent(app);
  const start = await agent.get(`/api/admin/oauth/openid?code_challenge=${codeChallenge}`);
  expect(start.status).toBe(302);

  const { code, state } = idp.authorize(start.headers.location);
  const exchangeCache = mockCaches.get(CacheKeys.ADMIN_OAUTH_EXCHANGE);
  const storedChallenge = await exchangeCache.get(`pkce:${state}`);
  const callback = await agent.get(
    `/api/admin/oauth/openid/callback?code=${code}&state=${encodeURIComponent(state)}`,
  );
  expect(callback.status).toBe(302);

  const panelCallback = new URL(callback.headers.location);
  expect(`${panelCallback.origin}${panelCallback.pathname}`).toBe(
    `${ADMIN_PANEL_URL}/auth/openid/callback`,
  );
  return {
    agent,
    storedChallenge,
    pendingChallenge: await exchangeCache.get(`pkce:${state}`),
    exchangeCode: panelCallback.searchParams.get('code'),
  };
}

const exchange = (agent, code, codeVerifier) =>
  agent
    .post('/api/admin/oauth/exchange')
    .set('Origin', ADMIN_PANEL_URL)
    .send({ code, code_verifier: codeVerifier });

describe('admin OpenID sign-in keeps the admin PKCE challenge', () => {
  const ORIGINAL_ENV = { ...process.env };
  const codeVerifier = crypto.randomBytes(32).toString('hex');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('hex');

  beforeEach(() => {
    mockCaches.clear();
    process.env.OPENID_ISSUER = ISSUER;
    process.env.OPENID_CLIENT_ID = CLIENT_ID;
    process.env.OPENID_CLIENT_SECRET = 'client-secret';
    process.env.OPENID_SCOPE = 'openid profile email';
    process.env.OPENID_CALLBACK_URL = '/oauth/openid/callback';
    for (const key of [
      'OPENID_USE_PKCE',
      'OPENID_GENERATE_NONCE',
      'OPENID_AUDIENCE',
      'OPENID_REQUIRED_ROLE',
      'OPENID_ADMIN_ROLE',
      'OPENID_REUSE_TOKENS',
      'OPENID_ON_BEHALF_FLOW_FOR_USERINFO_REQUIRED',
    ]) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe.each([
    ['advertises S256 (Keycloak)', ['S256']],
    ['omits code_challenge_methods_supported (Entra ID)', undefined],
  ])('when the IdP %s', (_label, codeChallengeMethods) => {
    let idp;
    let app;

    beforeEach(async () => {
      idp = createIdp(discovery(codeChallengeMethods));
      if (!(await setupOpenId())) {
        throw new Error('OpenID discovery against the stub IdP failed');
      }
      app = createApp();
    });

    it('sends the state the admin challenge is stored under and finds it on the callback', async () => {
      const warn = jest.spyOn(logger, 'warn');
      const { agent, storedChallenge, pendingChallenge, exchangeCode } = await signIn(
        app,
        idp,
        codeChallenge,
      );

      expect(storedChallenge).toBe(codeChallenge);
      expect(pendingChallenge).toBeUndefined();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('no PKCE challenge found'));

      const withoutVerifier = await exchange(agent, exchangeCode);
      expect(withoutVerifier.status).toBe(401);
      expect(withoutVerifier.body.error_code).toBe('INVALID_OR_EXPIRED_CODE');
    });

    it('issues the admin token only for the matching code_verifier', async () => {
      const wrong = await signIn(app, idp, codeChallenge);
      const wrongVerifier = await exchange(wrong.agent, wrong.exchangeCode, 'not-the-verifier');
      expect(wrongVerifier.status).toBe(401);

      const right = await signIn(app, idp, codeChallenge);
      const exchanged = await exchange(right.agent, right.exchangeCode, codeVerifier);
      expect(exchanged.status).toBe(200);
      expect(exchanged.body).toMatchObject({
        token: 'admin-session-token',
        user: { email: EMAIL, role: 'ADMIN' },
      });
    });

    it('adds a nonce only when the IdP does not advertise S256', async () => {
      await signIn(app, idp, codeChallenge);

      expect(Boolean(idp.authorization.nonce)).toBe(codeChallengeMethods == null);
    });

    it('leaves the chat sign-in request unchanged', async () => {
      const chat = await request(app).get('/oauth/openid');
      expect(chat.status).toBe(302);

      const params = new URL(chat.headers.location).searchParams;
      expect(params.has('nonce')).toBe(false);
      expect(params.has('state')).toBe(codeChallengeMethods == null);
    });
  });

  it.each([
    ['leaves the nonce out', null],
    ['carries the nonce of another request', 'another-requests-nonce'],
  ])('fails the Entra ID callback when the ID token %s', async (_label, idTokenNonce) => {
    const idp = createIdp(discovery());
    await setupOpenId();
    const agent = request.agent(createApp());

    const start = await agent.get(`/api/admin/oauth/openid?code_challenge=${codeChallenge}`);
    const { code, state } = idp.authorize(start.headers.location);
    idp.idTokenNonce = idTokenNonce;
    const callback = await agent.get(
      `/api/admin/oauth/openid/callback?code=${code}&state=${state}`,
    );

    const redirect = new URL(callback.headers.location ?? '/', ADMIN_PANEL_URL);
    expect(redirect.searchParams.has('code')).toBe(false);
  });
});
