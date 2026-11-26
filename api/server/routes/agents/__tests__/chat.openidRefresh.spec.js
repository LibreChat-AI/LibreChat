const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

/**
 * A custom endpoint that forwards `{{LIBRECHAT_OPENID_ACCESS_TOKEN}}` gets a current token when the
 * one the user signed in with has expired. The request is real end to end: an OpenID sign-in
 * through the application's own token handling into the express session it configures, the
 * `openidJwt` strategy and `requireJwtAuth`, the agents chat router with its access middleware and
 * `buildEndpointOption`, the session refresh service and the chat controller, on a real database.
 *
 * Two edges are faked. The identity provider answers discovery and the refresh grant through
 * `openid-client`, and serves its signing keys from a local JWKS endpoint. The model is not
 * called: `initializeClient` resolves the endpoint headers from the request the turn carries, as
 * the run does before its first model request, and ends the turn there.
 */

const ISSUER = 'https://idp.example.test/tenant';
const CLIENT_ID = 'librechat-client';
const SUBJECT = 'oidc-subject-18221';
const BEARER = 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}';

/** The api jest config maps the ESM-only `openid-client` to `test/__mocks__/openid-client.js`;
 *  the provider's discovery document and refresh grant are answered on top of that double. */
const mockIdp = { metadata: undefined, refreshTokenGrant: jest.fn() };
jest.mock('openid-client', () => ({
  ...jest.requireActual('openid-client'),
  discovery: async (_issuer, clientId) => ({
    serverMetadata: () => mockIdp.metadata,
    clientMetadata: () => ({ client_id: clientId }),
  }),
  refreshTokenGrant: (...args) => mockIdp.refreshTokenGrant(...args),
}));

/** Each turn that reaches the model boundary, with the headers its endpoint would receive. */
const mockTurns = [];
const mockTurnWaiters = [];
jest.mock('~/server/services/Endpoints/agents', () => {
  const actual = jest.requireActual('~/server/services/Endpoints/agents');
  return {
    ...actual,
    initializeClient: async ({ req }) => {
      const { createSafeUser, resolveHeaders } = jest.requireActual('@librechat/api');
      const endpoint = req.config.endpoints.custom.find(({ name }) => name === req.body.endpoint);
      let turn;
      try {
        turn = {
          headers: resolveHeaders({
            headers: endpoint.headers,
            user: createSafeUser(req.user),
            stripUnresolved: true,
          }),
        };
      } catch (error) {
        turn = { error: error.name };
      }
      mockTurns.push(turn);
      mockTurnWaiters.shift()?.(turn);
      throw new Error('The model boundary ends this turn.');
    },
  };
});

const now = () => Math.floor(Date.now() / 1000);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_ID = 'idp-signing-key';
const sign = (claims) =>
  jwt.sign({ iss: ISSUER, sub: SUBJECT, iat: now(), ...claims }, privateKey, {
    algorithm: 'RS256',
    keyid: KEY_ID,
  });
const idToken = () =>
  sign({ aud: CLIENT_ID, exp: now() + 3600, email: 'ada@example.test', name: 'Ada' });
const accessToken = (exp) => sign({ aud: 'api://gateway', scp: 'access_as_user', exp });

/** What the provider's token endpoint answers, in openid-client's token-set shape. */
function tokenSet({ access, refresh }) {
  const id = idToken();
  return {
    access_token: access,
    id_token: id,
    refresh_token: refresh,
    token_type: 'Bearer',
    claims: () => jwt.decode(id),
  };
}

const ENV = {
  OPENID_ISSUER: ISSUER,
  OPENID_CLIENT_ID: CLIENT_ID,
  OPENID_CLIENT_SECRET: 'client-secret',
  OPENID_SCOPE: 'openid profile email offline_access',
  OPENID_SESSION_SECRET: 'openid-session-secret',
  OPENID_CALLBACK_URL: '/oauth/openid/callback',
  OPENID_REUSE_TOKENS: 'true',
  DOMAIN_CLIENT: 'http://localhost:3080',
  DOMAIN_SERVER: 'http://localhost:3080',
  JWT_SECRET: 'jwt-secret',
  JWT_REFRESH_SECRET: 'jwt-refresh-secret',
  BAN_VIOLATIONS: 'false',
};
const savedEnv = Object.fromEntries(
  [...Object.keys(ENV), 'CONFIG_PATH'].map((key) => [key, process.env[key]]),
);

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librechat-openid-refresh-'));
const configPath = path.join(configDir, 'librechat.yaml');

let app;
let idp;
let mongo;
let userId;
let mongoose;
let GenerationJobManager;

beforeAll(async () => {
  Object.assign(process.env, ENV, { CONFIG_PATH: configPath });
  const { Constants } = require('librechat-data-provider');
  fs.writeFileSync(
    configPath,
    yaml.dump({
      version: Constants.CONFIG_VERSION,
      endpoints: {
        custom: [
          {
            name: 'gateway',
            apiKey: 'gateway-key',
            baseURL: 'https://gateway.example.test/v1',
            models: { default: ['gateway-model'] },
            headers: { Authorization: BEARER },
          },
          {
            name: 'plain',
            apiKey: 'plain-key',
            baseURL: 'https://plain.example.test/v1',
            models: { default: ['plain-model'] },
            headers: { 'X-Org': 'org' },
          },
        ],
      },
    }),
  );

  const jwks = {
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, alg: 'RS256', use: 'sig' }],
  };
  idp = http.createServer((req, res) => {
    res.writeHead(req.url === '/jwks' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(req.url === '/jwks' ? JSON.stringify(jwks) : '{}');
  });
  await new Promise((resolve) => idp.listen(0, '127.0.0.1', resolve));
  mockIdp.metadata = {
    issuer: ISSUER,
    jwks_uri: `http://127.0.0.1:${idp.address().port}/jwks`,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
  };

  mongo = await MongoMemoryServer.create();
  mongoose = require('mongoose');
  await mongoose.connect(mongo.getUri());
  const schemas = require('@librechat/data-schemas');
  schemas.createModels(mongoose);
  const models = require('~/models');
  await schemas.runAsSystem(async () => {
    await models.initializeRoles();
    const user = await mongoose.models.User.create({
      email: 'ada@example.test',
      name: 'Ada',
      username: 'ada',
      emailVerified: true,
      provider: 'openid',
      openidId: SUBJECT,
      openidIssuer: ISSUER,
      role: 'USER',
    });
    userId = user._id.toString();
  });

  const api = require('@librechat/api');
  GenerationJobManager = api.GenerationJobManager;
  GenerationJobManager.configure({ ...api.createStreamServices(), cleanupOnComplete: true });
  GenerationJobManager.initialize();

  const express = require('express');
  const passport = require('passport');
  const { setOpenIDAuthTokens } = require('~/server/services/AuthService');
  const { requireJwtAuth, strictConfigMiddleware } = require('~/server/middleware');
  app = express();
  app.use(express.json());
  app.use(passport.initialize());
  passport.use(require('~/strategies/jwtStrategy')());
  await require('~/server/socialLogins')(app, {});
  /** The end of an OpenID sign-in: the provider's token set handed to the application. */
  app.post('/test/openid-sign-in', (req, res) => {
    const token = setOpenIDAuthTokens(req.body.tokenset, req, res, {
      userId,
      openidSubject: SUBJECT,
      openidIssuer: ISSUER,
    });
    res.json({ token });
  });
  app.use('/api/agents/chat', requireJwtAuth, strictConfigMiddleware);
  app.use('/api/agents/chat', require('../chat'));
  app.use(api.ErrorController);
}, 180000);

afterAll(async () => {
  await GenerationJobManager?.destroy();
  await mongoose?.disconnect();
  await mongo?.stop();
  await new Promise((resolve) => (idp ? idp.close(resolve) : resolve()));
  fs.rmSync(configDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}, 180000);

beforeEach(() => {
  mockIdp.refreshTokenGrant.mockReset();
});

/** Signs in with an access token that has already expired, as a session left idle has. */
async function signIn() {
  const tokenset = tokenSet({ access: accessToken(now() - 60), refresh: 'refresh-at-sign-in' });
  delete tokenset.claims;
  const response = await request(app).post('/test/openid-sign-in').send({ tokenset });
  expect(response.status).toBe(200);
  const cookies = Object.fromEntries(
    response.headers['set-cookie'].map((cookie) => {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      return [pair.slice(0, index), pair.slice(index + 1)];
    }),
  );
  return { bearer: response.body.token, cookies };
}

/** The browser's request for a turn; without `connect.sid` its OpenID session has lapsed. */
function sendTurn({ bearer, cookies }, endpoint, { lapsed = false } = {}) {
  const cookie = Object.entries(cookies)
    .filter(([name]) => !(lapsed && name === 'connect.sid'))
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  return request(app)
    .post(`/api/agents/chat/${endpoint}`)
    .set('Authorization', `Bearer ${bearer}`)
    .set('Cookie', cookie)
    .send({
      text: 'Hello',
      sender: 'User',
      isCreatedByUser: true,
      messageId: crypto.randomUUID(),
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      endpoint,
      endpointType: 'custom',
      model: `${endpoint}-model`,
    });
}

/** The next turn to reach the model boundary. */
function nextTurn() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no turn reached the model boundary')), 60000);
    mockTurnWaiters.push((turn) => {
      clearTimeout(timer);
      resolve(turn);
    });
  });
}

it('refreshes an expired OpenID access token before the turn forwards it to the endpoint', async () => {
  const session = await signIn();
  const refreshed = accessToken(now() + 3600);
  mockIdp.refreshTokenGrant.mockResolvedValueOnce(
    tokenSet({ access: refreshed, refresh: 'refresh-after-rotation' }),
  );

  const turn = nextTurn();
  const response = await sendTurn(session, 'gateway');

  expect(response.status).toBe(200);
  expect(response.body.streamId).toEqual(expect.any(String));
  await expect(turn).resolves.toEqual({ headers: { Authorization: `Bearer ${refreshed}` } });
  expect(mockIdp.refreshTokenGrant).toHaveBeenCalledTimes(1);
  expect(mockIdp.refreshTokenGrant.mock.calls[0][1]).toBe('refresh-at-sign-in');

  const followUp = nextTurn();
  await sendTurn(session, 'gateway').expect(200);
  await expect(followUp).resolves.toEqual({ headers: { Authorization: `Bearer ${refreshed}` } });
  expect(mockIdp.refreshTokenGrant).toHaveBeenCalledTimes(1);
}, 120000);

it('answers 401 before the turn starts when the OpenID session has lapsed', async () => {
  const session = await signIn();
  const reached = mockTurns.length;

  const response = await sendTurn(session, 'gateway', { lapsed: true });

  expect(response.status).toBe(401);
  expect(response.body).toEqual({
    error: 'invalid_token',
    message: expect.stringContaining('Please sign in again'),
  });
  expect(mockTurns).toHaveLength(reached);
  expect(mockIdp.refreshTokenGrant).not.toHaveBeenCalled();
}, 120000);

it('starts a turn on an endpoint that does not forward the token without the session', async () => {
  const session = await signIn();

  const turn = nextTurn();
  await sendTurn(session, 'plain', { lapsed: true }).expect(200);

  await expect(turn).resolves.toEqual({ headers: { 'X-Org': 'org' } });
  expect(mockIdp.refreshTokenGrant).not.toHaveBeenCalled();
}, 120000);
