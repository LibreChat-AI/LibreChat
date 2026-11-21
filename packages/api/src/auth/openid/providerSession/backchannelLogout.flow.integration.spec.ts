import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { OPENID_SESSION_ENDED } from 'librechat-data-provider';
import { createMethods, createModels, runAsSystem } from '@librechat/data-schemas';
import type { ProviderSessionRef, TOpenIdBackchannelLogoutConfig } from 'librechat-data-provider';
import type { ISession } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createBackchannelLogoutHandlers, excludeBackchannelLogoutBodyParser } from '../logout';
import { createLocalRefreshHandler } from '../../localRefresh';
import { createProviderSessionService } from './service';
import { markOpenIDLoginIssued } from './callback';

/**
 * End-to-end flow over HTTP: an OpenID callback establishes the provider session and creates the
 * app Session with `createSession`; the IdP POSTs a signed logout token to the back-channel route;
 * the browser's next local refresh (with its rotated refresh token) is denied.
 *
 * Real: provider-session service, callback step, logout handlers and body parsers, JWKS key
 * resolver (served from a local HTTP JWKS endpoint), local refresh handler, data-schemas session
 * and provider-session methods on an in-memory MongoDB.
 * Stubbed: passport (sets `req.user` with a tokenset), the openid-client Configuration
 * (`serverMetadata()` only), and `/api`'s `setAuthTokens`, reduced to the same
 * `createSession` / `generateRefreshToken` calls plus a `refreshToken` cookie.
 */

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'librechat';
const CLIENT_DOMAIN = 'https://chat.example.com';
const KID = 'flow-kid-1';
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const LOGOUT_PATH = '/oauth/openid/backchannel-logout';
const CALLBACK_PATH = '/oauth/openid/callback';
const REFRESH_PATH = '/api/auth/refresh';
const REFRESH_TOKEN_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7;

type Mode = TOpenIdBackchannelLogoutConfig['mode'];

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let privateKeyPem: string;
let jwksServer: http.Server;
let jwksUri: string;

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function signLogoutToken(claims: { sid: string; sub?: string }): string {
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...claims,
  };
  return jwt.sign(payload, privateKeyPem, { algorithm: 'RS256', keyid: KID });
}

function readRefreshCookie(cookieHeader: string | undefined): string | undefined {
  const pair = (cookieHeader ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('refreshToken='));
  return pair ? decodeURIComponent(pair.slice('refreshToken='.length)) : undefined;
}

function refreshCookieFrom(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return readRefreshCookie(raw?.find((cookie) => cookie.startsWith('refreshToken=')));
}

/** Builds the app the way `api/server/index.js` and `routes/oauth.js` wire it, with one fresh
 *  provider-session service per app so each test resolves its own mode. */
function buildApp(mode: Mode) {
  const logger = makeLogger();
  const revokeSpy = jest.fn(methods.revokeProviderSession);
  const establishSpy = jest.fn(methods.establishProviderSession);
  const authorizeSpy = jest.fn(methods.authorizeProviderSession);

  const openIdConfiguration = {
    serverMetadata: () => ({ issuer: ISSUER, jwks_uri: jwksUri }),
  };

  const service = createProviderSessionService({
    methods: { establish: establishSpy, authorize: authorizeSpy, revoke: revokeSpy },
    getAppConfig: async () => ({ registration: { openidBackchannelLogout: { mode } } }),
    getOpenIdClient: () => openIdConfiguration,
    getClientId: () => CLIENT_ID,
    storeOpenIDSession: jest.fn(),
    logger,
  });

  const logoutHandlers = createBackchannelLogoutHandlers({
    getConfig: service.getBackchannelLogoutConfig,
    getClient: service.getProviderSessionClient,
    getJwksUri: () => openIdConfiguration.serverMetadata().jwks_uri,
    getCacheMaxAgeMs: () => 60000,
    revokeProviderSession: (data) => runAsSystem(() => service.revokeProviderSession(data)),
    logger,
  });

  /** Mirrors `setAuthTokens` in `api/server/services/AuthService.js`: rotate an existing
   *  session's refresh token, or create a new session bound to the provider session. */
  async function setAuthTokens(
    userId: string,
    res: Response,
    session: ISession | null,
    _req: Request | null,
    options: { providerSession?: ProviderSessionRef | null; authMethod?: string } = {},
  ): Promise<string> {
    let refreshToken: string;
    let expires: Date | undefined;
    if (session && session._id && session.expiration != null) {
      expires = session.expiration;
      refreshToken = await methods.generateRefreshToken(session);
    } else {
      const result = await methods.createSession(userId, {
        expiresIn: REFRESH_TOKEN_EXPIRY_MS,
        providerSession: options.providerSession ?? undefined,
        authMethod: options.authMethod as never,
      });
      expires = result.session.expiration;
      refreshToken = result.refreshToken;
    }
    res.cookie('refreshToken', refreshToken, { expires, httpOnly: true, path: '/' });
    return 'access-token';
  }

  const refreshLocalSession = createLocalRefreshHandler({
    userProjection: '-password',
    getUserById: methods.getUserById as never,
    findSession: methods.findSession as never,
    setAuthTokens: setAuthTokens as never,
    authorizeProviderSession: (input) => service.getProviderSessionAuthorizer().authorize(input),
    deleteAllUserSessions: methods.deleteAllUserSessions as never,
    deleteSession: methods.deleteSession,
    clearCloudFrontCookies: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });

  const app = express();
  app.use(excludeBackchannelLogoutBodyParser(express.json({ limit: '3mb' })));
  app.use(excludeBackchannelLogoutBodyParser(express.urlencoded({ extended: true, limit: '3mb' })));

  const oauthRouter = express.Router();
  oauthRouter.post(
    '/openid/backchannel-logout',
    logoutHandlers.requireBackchannelLogoutEnabled,
    logoutHandlers.parseBackchannelLogoutBody,
    logoutHandlers.handleBackchannelLogout,
  );

  /** Stands in for passport's OpenID strategy: the login started at `issuedAt` (stamped by
   *  `markOpenIDLoginIssued`, as `openidStrategy.js` does) and returned these ID token claims. */
  oauthRouter.get(
    '/openid/callback',
    (req, _res, next) => {
      const { uid, sub, sid, issuedAt } = req.query as Record<string, string>;
      const session: { openidLoginIssuedAt?: number } = {};
      markOpenIDLoginIssued(session, issuedAt ? Number(issuedAt) : Date.now());
      Object.assign(req, {
        session,
        user: {
          _id: uid,
          provider: 'openid',
          tokenset: { claims: () => ({ iss: ISSUER, sub, ...(sid ? { sid } : {}) }) },
        },
      });
      next();
    },
    /** Same order as `createOAuthHandler` in `api/server/controllers/auth/oauth.js`. */
    async (req, res, next) => {
      try {
        const providerSessionRef = await service.establishOAuthCallback({
          req: req as never,
          res,
          clientDomain: CLIENT_DOMAIN,
        });
        if (providerSessionRef === undefined) {
          return;
        }
        const user = (req as unknown as { user: { _id: string } }).user;
        await setAuthTokens(user._id, res, null, req, {
          providerSession: providerSessionRef,
          authMethod: 'openid',
        });
        res.redirect(CLIENT_DOMAIN);
      } catch (error) {
        next(error);
      }
    },
  );
  app.use('/oauth', oauthRouter);

  app.post(REFRESH_PATH, async (req, res) => {
    await refreshLocalSession(req, res, readRefreshCookie(req.headers.cookie));
  });

  return { app, revokeSpy, establishSpy, authorizeSpy };
}

async function createUser(sub: string): Promise<string> {
  const user = await mongoose.models.User.create({
    name: sub,
    username: sub,
    email: `${sub}@example.com`,
    emailVerified: true,
    provider: 'openid',
    openidId: sub,
  });
  return user._id.toString();
}

/** Signs one browser in through the callback; the agent keeps the browser's cookies. */
async function signIn(
  app: express.Express,
  login: { uid: string; sub: string; sid: string; issuedAt?: number },
) {
  const agent = request.agent(app);
  const res = await agent.get(CALLBACK_PATH).query(login);
  return { agent, res };
}

function postLogout(app: express.Express, claims: { sid: string; sub?: string }) {
  return request(app)
    .post(LOGOUT_PATH)
    .type('form')
    .send({ logout_token: signLogoutToken(claims) });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  jwksServer = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  jwksUri = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;

  process.env.JWT_REFRESH_SECRET = 'flow-refresh-secret';
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  await new Promise((resolve) => jwksServer.close(resolve));
  await mongoose.disconnect();
  await mongoServer?.stop();
});

/** Clears documents only, keeping the indexes the session methods create once per instance. */
beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
});

describe('back-channel logout flow: callback -> createSession -> HTTP logout -> refresh', () => {
  it('ends only the browser whose sid was logged out; the same user on another sid keeps refreshing', async () => {
    const { app } = buildApp('enforce');
    const uid = await createUser('sub-two-browsers');

    const browserA = await signIn(app, { uid, sub: 'sub-two-browsers', sid: 'sid-browser-a' });
    const browserB = await signIn(app, { uid, sub: 'sub-two-browsers', sid: 'sid-browser-b' });
    expect(browserA.res.status).toBe(302);
    expect(browserA.res.headers.location).toBe(CLIENT_DOMAIN);
    expect(browserB.res.headers.location).toBe(CLIENT_DOMAIN);
    expect(await mongoose.models.Session.countDocuments({ user: uid })).toBe(2);

    const logout = await postLogout(app, { sid: 'sid-browser-a', sub: 'sub-two-browsers' });
    expect(logout.status).toBe(200);
    expect(logout.headers['cache-control']).toBe('no-store');

    const refreshA = await browserA.agent.post(REFRESH_PATH);
    expect(refreshA.status).toBe(401);
    expect(refreshA.body).toEqual({ code: OPENID_SESSION_ENDED });

    const refreshB = await browserB.agent.post(REFRESH_PATH);
    expect(refreshB.status).toBe(200);
    expect(refreshB.body.token).toBe('access-token');
  });

  it('denies the rotated refresh token with 401 OPENID_SESSION_ENDED after logout', async () => {
    const { app } = buildApp('enforce');
    const uid = await createUser('sub-rotated');

    const browser = await signIn(app, { uid, sub: 'sub-rotated', sid: 'sid-rotated' });
    const loginToken = refreshCookieFrom(browser.res);
    expect(loginToken).toBeDefined();

    const firstRefresh = await browser.agent.post(REFRESH_PATH);
    expect(firstRefresh.status).toBe(200);
    const rotatedToken = refreshCookieFrom(firstRefresh);
    expect(rotatedToken).toBeDefined();
    expect(rotatedToken).not.toBe(loginToken);

    const stored = await mongoose.models.Session.findOne({ user: uid }).lean<ISession>();
    expect(stored?.providerSession).toMatchObject({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      sid: 'sid-rotated',
    });
    expect(stored?.authMethod).toBe('openid');

    const logout = await postLogout(app, { sid: 'sid-rotated', sub: 'sub-rotated' });
    expect(logout.status).toBe(200);

    const denied = await request(app)
      .post(REFRESH_PATH)
      .set('Cookie', `refreshToken=${rotatedToken}`);
    expect(denied.status).toBe(401);
    expect(denied.body).toEqual({ code: OPENID_SESSION_ENDED });
    expect(await mongoose.models.Session.countDocuments({ user: uid })).toBe(0);
  });

  it('answers a second refresh after the deny with a plain 401: the session is already deleted', async () => {
    const { app } = buildApp('enforce');
    const uid = await createUser('sub-second');

    const browser = await signIn(app, { uid, sub: 'sub-second', sid: 'sid-second' });
    expect((await postLogout(app, { sid: 'sid-second', sub: 'sub-second' })).status).toBe(200);

    const first = await browser.agent.post(REFRESH_PATH);
    expect(first.status).toBe(401);
    expect(first.body).toEqual({ code: OPENID_SESSION_ENDED });

    /** The deny deleted the Session, so the lookup finds nothing and the provider-session check
     *  never runs: the generic "not found" text, not the OPENID_SESSION_ENDED code. */
    const second = await browser.agent.post(REFRESH_PATH);
    expect(second.status).toBe(401);
    expect(second.text).toBe('Refresh token expired or not found for this user');
    expect(second.text).not.toContain(OPENID_SESSION_ENDED);
  });

  it('denies a new sign-in through the callback that carries the revoked sid', async () => {
    const { app } = buildApp('enforce');
    const uid = await createUser('sub-relogin');

    await signIn(app, { uid, sub: 'sub-relogin', sid: 'sid-relogin' });
    expect((await postLogout(app, { sid: 'sid-relogin', sub: 'sub-relogin' })).status).toBe(200);
    expect(await mongoose.models.Session.countDocuments({ user: uid })).toBe(1);

    const again = await signIn(app, { uid, sub: 'sub-relogin', sid: 'sid-relogin' });
    expect(again.res.status).toBe(302);
    expect(again.res.headers.location).toBe(
      `${CLIENT_DOMAIN}/login?redirect=false&error=${OPENID_SESSION_ENDED}`,
    );
    expect(refreshCookieFrom(again.res)).toBeUndefined();
    expect(await mongoose.models.Session.countDocuments({ user: uid })).toBe(1);
  });

  it('denies a login whose callback completes after the logout for its sid arrived', async () => {
    const { app } = buildApp('enforce');
    const uid = await createUser('sub-pending');
    const loginStartedAt = Date.now();

    const logout = await postLogout(app, { sid: 'sid-pending', sub: 'sub-pending' });
    expect(logout.status).toBe(200);
    const tombstone = await mongoose.models.ProviderSession.findOne({ sid: 'sid-pending' }).lean<{
      revokedAt?: Date;
    }>();
    expect(tombstone?.revokedAt).toBeInstanceOf(Date);

    const callback = await signIn(app, {
      uid,
      sub: 'sub-pending',
      sid: 'sid-pending',
      issuedAt: loginStartedAt,
    });
    expect(callback.res.status).toBe(302);
    expect(callback.res.headers.location).toBe(
      `${CLIENT_DOMAIN}/login?redirect=false&error=${OPENID_SESSION_ENDED}`,
    );
    expect(refreshCookieFrom(callback.res)).toBeUndefined();
    expect(await mongoose.models.Session.countDocuments({ user: uid })).toBe(0);
  });

  it('rejects a JSON-bodied logout POST with 400 and revokes nothing', async () => {
    const { app, revokeSpy } = buildApp('enforce');
    const uid = await createUser('sub-json');
    const browser = await signIn(app, { uid, sub: 'sub-json', sid: 'sid-json' });

    const res = await request(app)
      .post(LOGOUT_PATH)
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({ logout_token: signLogoutToken({ sid: 'sid-json', sub: 'sub-json' }) }),
      );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(revokeSpy).not.toHaveBeenCalled();
    expect((await browser.agent.post(REFRESH_PATH)).status).toBe(200);
  });

  it('mode off: the logout route answers 404 with no database work, and refresh is not denied', async () => {
    const { app, revokeSpy, establishSpy, authorizeSpy } = buildApp('off');
    const uid = await createUser('sub-off');

    const browser = await signIn(app, { uid, sub: 'sub-off', sid: 'sid-off' });
    expect(browser.res.headers.location).toBe(CLIENT_DOMAIN);
    const stored = await mongoose.models.Session.findOne({ user: uid }).lean<ISession>();
    expect(stored?.providerSession).toBeUndefined();

    const logout = await postLogout(app, { sid: 'sid-off', sub: 'sub-off' });
    expect(logout.status).toBe(404);

    const refresh = await browser.agent.post(REFRESH_PATH);
    expect(refresh.status).toBe(200);

    expect(revokeSpy).not.toHaveBeenCalled();
    expect(establishSpy).not.toHaveBeenCalled();
    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(await mongoose.models.ProviderSession.countDocuments({})).toBe(0);
  });
});
