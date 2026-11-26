const path = require('path');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'librechat-client';
const SUBJECT = 'idp-subject';
const EMAIL = 'reuse@example.com';
const savedEnv = { ...process.env };

/**
 * An identity provider that behaves like Dex: every refresh grant issues a new ID token and a new
 * refresh token, and the token it was given stops working. With `rotate` off it keeps the refresh
 * token instead, as Keycloak or Okta do with rotation disabled; `lifetime` is in seconds.
 */
function createIdentityProvider() {
  const issued = [];
  const options = { rotate: true, lifetime: 120 };
  let current;
  const issue = (refreshToken) => {
    const sequence = issued.length;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + options.lifetime;
    const claims = { iss: ISSUER, sub: SUBJECT, aud: CLIENT_ID, email: EMAIL, iat, exp };
    const tokenset = {
      access_token: jwt.sign({ ...claims, jti: `access-${sequence}` }, 'idp-signing-key'),
      id_token: jwt.sign({ ...claims, jti: `id-${sequence}` }, 'idp-signing-key'),
      refresh_token: refreshToken ?? `refresh-${sequence}`,
      token_type: 'bearer',
      expires_in: options.lifetime,
      claims: () => claims,
    };
    current = tokenset.refresh_token;
    issued.push(tokenset);
    return tokenset;
  };
  const refreshTokenGrant = jest.fn(async (_config, refreshToken) => {
    if (refreshToken !== current) {
      throw Object.assign(new Error('invalid_grant'), { error: 'invalid_grant' });
    }
    return issue(options.rotate ? undefined : refreshToken);
  });
  return { issued, issue, options, refreshTokenGrant };
}

const getCookie = (response, name) => {
  const cookie = (response.headers['set-cookie'] ?? []).find((value) =>
    value.startsWith(`${name}=`),
  );
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1).split(';')[0]) : undefined;
};

/**
 * Sign-in and `/api/auth/refresh` with OPENID_REUSE_TOKENS, wired as production wires them: the
 * OAuth and auth routers, the OpenID session store, the refresh and publication services, and their
 * coordination records in MongoDB. Only the identity provider is replaced.
 */
describe('OpenID token reuse from sign-in through refresh', () => {
  let mongo;
  let mongoose;
  let request;
  let app;
  let idp;

  beforeAll(async () => {
    Object.assign(process.env, {
      DOMAIN_CLIENT: 'http://localhost:3080',
      DOMAIN_SERVER: 'http://localhost:3080',
      CONFIG_PATH: path.join(__dirname, 'missing-librechat.yaml'),
      BAN_VIOLATIONS: 'false',
      LOGIN_MAX: '1000',
      OPENID_ISSUER: ISSUER,
      OPENID_CLIENT_ID: CLIENT_ID,
      OPENID_REUSE_TOKENS: 'true',
      /** No refresh may reuse the session's tokens, so each one spends a refresh grant. */
      OPENID_REUSE_MAX_SESSION_AGE_MS: '1',
    });
    jest.resetModules();
    idp = createIdentityProvider();
    const openIdClient = require('openid-client');
    openIdClient.refreshTokenGrant = idp.refreshTokenGrant;
    openIdClient.randomState = () => 'state';
    jest.doMock('~/strategies/openidStrategy', () => ({
      ...jest.requireActual('~/strategies/openidStrategy'),
      getOpenIdConfig: () => ({ serverMetadata: () => ({ issuer: ISSUER }) }),
    }));

    const express = require('express');
    const session = require('express-session');
    const passport = require('passport');
    const { CacheKeys } = require('librechat-data-provider');
    request = require('supertest');
    mongoose = require('mongoose');
    const schemas = require('@librechat/data-schemas');
    const api = require('@librechat/api');

    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    schemas.createModels(mongoose);
    const user = await mongoose.models.User.create({
      email: EMAIL,
      name: 'Reuse',
      username: 'reuse',
      emailVerified: true,
      provider: 'openid',
      openidId: SUBJECT,
      openidIssuer: ISSUER,
      role: 'USER',
    });

    passport.use('openid', {
      name: 'openid',
      authenticate() {
        const tokenset = idp.issue();
        this.success({ ...user.toObject(), tokenset });
      },
    });

    const getLogStores = require('~/cache/getLogStores');
    app = express();
    app.use(express.json());
    app.use(
      session({
        secret: 'openid-session-secret',
        resave: false,
        saveUninitialized: false,
        store: getLogStores(CacheKeys.OPENID_SESSION),
      }),
    );
    app.use(passport.initialize());
    app.use('/api/auth', api.preAuthTenantMiddleware, require('../auth'));
    app.use('/oauth', api.preAuthTenantMiddleware, require('../oauth'));
    app.use(api.ErrorController);
  }, 180000);

  afterAll(async () => {
    await mongoose?.disconnect();
    await mongo?.stop();
    process.env = savedEnv;
  }, 180000);

  /** Signs in through the OpenID callback; returns the browser and the sign-in token set. */
  async function signIn() {
    const agent = request.agent(app);
    const issued = idp.issued.length;
    const response = await agent.get('/oauth/openid/callback?code=code&state=state');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('http://localhost:3080');
    const tokens = idp.issued[issued];
    expect(getCookie(response, 'refreshToken')).toBe(tokens.refresh_token);
    return { agent, issued };
  }

  it('answers the first refresh after sign-in with the ID token its grant issued', async () => {
    const { agent, issued } = await signIn();

    const refresh = await agent.post('/api/auth/refresh');
    expect(refresh.status).toBe(200);
    expect(idp.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(idp.refreshTokenGrant.mock.calls[0][1]).toBe(idp.issued[issued].refresh_token);
    expect(refresh.body.token).toBe(idp.issued[issued + 1].id_token);
    expect(refresh.body.token).not.toBe(idp.issued[issued].id_token);
    expect(getCookie(refresh, 'refreshToken')).toBe(idp.issued[issued + 1].refresh_token);
  });

  /** The provider refuses the spent sign-in token, so a session left on it would end in a 403. */
  it('refreshes again with the token the first grant rotated in', async () => {
    const { agent, issued } = await signIn();

    expect((await agent.post('/api/auth/refresh')).status).toBe(200);
    const refresh = await agent.post('/api/auth/refresh');
    expect(refresh.status).toBe(200);
    expect(idp.refreshTokenGrant).toHaveBeenCalledTimes(2);
    expect(idp.refreshTokenGrant.mock.calls[1][1]).toBe(idp.issued[issued + 1].refresh_token);
    expect(refresh.body.token).toBe(idp.issued[issued + 2].id_token);
    expect(getCookie(refresh, 'refreshToken')).toBe(idp.issued[issued + 2].refresh_token);
  });

  /**
   * Every grant of a kept refresh token publishes under one key. The answer to a refresh holds its
   * publication open for a delivery lease of 30 s, longer than the tokens below stay outside the
   * 30 s expiry buffer, so the next grant meets a publication whose tokens nobody may reuse.
   */
  describe('with a provider that keeps the refresh token', () => {
    const SHORT_LIFETIME = 31;
    /** Past the second in which tokens of {@link SHORT_LIFETIME} stop being reusable. */
    const outliveShortTokens = () => new Promise((resolve) => setTimeout(resolve, 2000));

    beforeEach(() => {
      idp.options.rotate = false;
    });

    afterEach(() => {
      Object.assign(idp.options, { rotate: true, lifetime: 120 });
    });

    it('answers a refresh after the last grant ran out with the ID token of its own grant', async () => {
      const { agent, issued } = await signIn();
      idp.options.lifetime = SHORT_LIFETIME;
      const first = await agent.post('/api/auth/refresh');
      expect(first.status).toBe(200);
      expect(first.body.token).toBe(idp.issued[issued + 1].id_token);
      await outliveShortTokens();

      idp.options.lifetime = 120;
      const refresh = await agent.post('/api/auth/refresh');
      expect(refresh.status).toBe(200);
      expect(idp.refreshTokenGrant).toHaveBeenCalledTimes(2);
      expect(idp.refreshTokenGrant.mock.calls[1][1]).toBe(idp.issued[issued].refresh_token);
      expect(refresh.body.token).toBe(idp.issued[issued + 2].id_token);

      const next = await agent.post('/api/auth/refresh');
      expect(next.status).toBe(200);
      expect(next.body.token).toBe(idp.issued[issued + 2].id_token);
      expect(idp.refreshTokenGrant).toHaveBeenCalledTimes(2);
    });

    it('shares one grant between tabs that refresh together after the last grant ran out', async () => {
      const { agent, issued } = await signIn();
      idp.options.lifetime = SHORT_LIFETIME;
      expect((await agent.post('/api/auth/refresh')).status).toBe(200);
      await outliveShortTokens();

      idp.options.lifetime = 120;
      const tabs = await Promise.all([
        agent.post('/api/auth/refresh'),
        agent.post('/api/auth/refresh'),
      ]);
      expect(tabs.map((tab) => tab.status)).toEqual([200, 200]);
      expect(idp.refreshTokenGrant).toHaveBeenCalledTimes(2);
      expect(tabs.map((tab) => tab.body.token)).toEqual([
        idp.issued[issued + 2].id_token,
        idp.issued[issued + 2].id_token,
      ]);
    });
  });
});
