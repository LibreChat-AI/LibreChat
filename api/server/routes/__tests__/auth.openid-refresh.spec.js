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
 * refresh token, and the token it was given stops working.
 */
function createIdentityProvider() {
  const issued = [];
  let current;
  const issue = () => {
    const sequence = issued.length;
    const iat = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, sub: SUBJECT, aud: CLIENT_ID, email: EMAIL, iat, exp: iat + 120 };
    const tokenset = {
      access_token: jwt.sign({ ...claims, jti: `access-${sequence}` }, 'idp-signing-key'),
      id_token: jwt.sign({ ...claims, jti: `id-${sequence}` }, 'idp-signing-key'),
      refresh_token: `refresh-${sequence}`,
      token_type: 'bearer',
      expires_in: 120,
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
    return issue();
  });
  return { issued, issue, refreshTokenGrant };
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

  it('answers each refresh with the tokens its grant issued, not the sign-in tokens', async () => {
    const agent = request.agent(app);
    const signIn = await agent.get('/oauth/openid/callback?code=code&state=state');
    expect(signIn.status).toBe(302);
    expect(signIn.headers.location).toBe('http://localhost:3080');
    expect(getCookie(signIn, 'refreshToken')).toBe(idp.issued[0].refresh_token);

    const first = await agent.post('/api/auth/refresh');
    expect(first.status).toBe(200);
    expect(idp.refreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(first.body.token).toBe(idp.issued[1].id_token);
    expect(getCookie(first, 'refreshToken')).toBe(idp.issued[1].refresh_token);

    /** The rotated token is the one the session now refreshes with; the sign-in token is spent. */
    const second = await agent.post('/api/auth/refresh');
    expect(second.status).toBe(200);
    expect(idp.refreshTokenGrant).toHaveBeenCalledTimes(2);
    expect(idp.refreshTokenGrant.mock.calls[1][1]).toBe(idp.issued[1].refresh_token);
    expect(second.body.token).toBe(idp.issued[2].id_token);
    expect(getCookie(second, 'refreshToken')).toBe(idp.issued[2].refresh_token);
  });
});
