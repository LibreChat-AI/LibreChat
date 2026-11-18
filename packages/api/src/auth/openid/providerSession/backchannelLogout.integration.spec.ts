import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import { OPENID_SESSION_ENDED, AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type { IProviderSession } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ResolvedBackchannelLogoutConfig } from './config';
import { receiveBackchannelLogout, isBackchannelLogoutEnabled } from '../logout';
import { createLocalRefreshHandler } from '../../localRefresh';
import { createProviderSessionAuthorizer } from './authorize';

/** Cross-path coverage: a real signed logout token runs the real receiver into a real database,
 * then the real authorizer is checked at each renewal/restoration call site. */

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
let keyPair: { publicKey: string; privateKey: string };

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'librechat';
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const JWT_REFRESH_SECRET = 'test-refresh-secret';

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function future(ms = 60_000): Date {
  return new Date(Date.now() + ms);
}

function makeConfig(
  overrides: Partial<ResolvedBackchannelLogoutConfig> = {},
): ResolvedBackchannelLogoutConfig {
  return {
    mode: 'record',
    algorithms: ['RS256'],
    clockToleranceSec: 60,
    maxTokenAgeSec: 120,
    maxBodyBytes: 16384,
    rateLimit: { windowMs: 60_000, max: 60 },
    processingTimeoutMs: 5000,
    callbackGraceMs: 600_000,
    ...overrides,
  };
}

function signLogoutToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: now,
    jti: crypto.randomUUID(),
    sid: 'sid-1',
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...overrides,
  };
  return jwt.sign(payload, keyPair.privateKey, { algorithm: 'RS256', keyid: 'kid-1' });
}

function makeAuthorizer(config: ResolvedBackchannelLogoutConfig, now?: () => Date) {
  return createProviderSessionAuthorizer({
    methods: {
      establish: methods.establishProviderSession,
      authorize: methods.authorizeProviderSession,
    },
    getConfig: () => Promise.resolve(config),
    logger: makeLogger(),
    ...(now ? { now } : {}),
  });
}

async function revokeViaReceiver(
  config: ResolvedBackchannelLogoutConfig,
  overrides?: Record<string, unknown>,
  revokeProviderSession = methods.revokeProviderSession,
) {
  return receiveBackchannelLogout(signLogoutToken(overrides), {
    config,
    client: { issuer: ISSUER, clientId: CLIENT_ID },
    resolveKey: async () => keyPair.publicKey,
    revokeProviderSession,
    logger: makeLogger(),
  });
}

function signRefreshJwt(userId: string): string {
  return jwt.sign({ id: userId }, JWT_REFRESH_SECRET);
}

function buildRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  return res;
}

function buildLocalHandler(
  authorizeProviderSession: (input: {
    ref: ProviderSessionRef | null;
    subject?: string;
    expiresAt: Date;
    legacy: boolean;
  }) => Promise<{ ok: boolean; code?: string }>,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return createLocalRefreshHandler({
    userProjection: 'projection',
    getUserById: async (userId: string) => ({ _id: userId, provider: 'openid' }),
    findSession: methods.findSession as never,
    setAuthTokens: jest.fn().mockResolvedValue('new-token'),
    authorizeProviderSession: authorizeProviderSession as never,
    deleteSession: methods.deleteSession,
    deleteAllUserSessions: jest.fn(),
    clearCloudFrontCookies: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    ...overrides,
  } as never);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
  const generated = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  keyPair = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

/** Clears documents only (not indexes): `dropDatabase()` would also drop the unique index that
 *  `ensureIndexes()` memoizes creating just once per `methods` instance. */
beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
});

describe('back-channel logout: real receiver + real database + real authorizer', () => {
  it('denies a local-mode refresh with 401 OPENID_SESSION_ENDED after a real signed logout notification', async () => {
    const config = makeConfig();
    const authorizer = makeAuthorizer(config);
    const ref = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-1' };
    const userId = new mongoose.Types.ObjectId().toString();
    const refreshJwt = signRefreshJwt(userId);

    await expect(
      authorizer.establish({
        ref,
        subject: 'sub-1',
        expiresAt: future(),
        callbackIssuedAt: new Date(),
      }),
    ).resolves.toEqual({ ok: true });
    await methods.upsertSession(userId, refreshJwt, {
      expiration: future(),
      providerSession: ref,
      authMethod: 'openid',
    });

    const revoked = await revokeViaReceiver(config, { sid: 'sid-1', sub: 'sub-1' });
    expect(revoked.status).toBe(200);

    const handler = buildLocalHandler(authorizer.authorize);
    const res = buildRes();
    await handler({ query: {} } as never, res, refreshJwt);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ code: OPENID_SESSION_ENDED });
    expect(res.clearCookie).not.toHaveBeenCalledWith('refreshToken');
  });

  it('denies the next renewal once logout lands after an earlier successful authorize (ordering)', async () => {
    const config = makeConfig();
    const authorizer = makeAuthorizer(config);
    const ref = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-3' };
    const userId = new mongoose.Types.ObjectId().toString();
    const refreshJwt = signRefreshJwt(userId);

    await authorizer.establish({
      ref,
      subject: 'sub-3',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });
    await methods.upsertSession(userId, refreshJwt, {
      expiration: future(),
      providerSession: ref,
      authMethod: 'openid',
    });

    const handler = buildLocalHandler(authorizer.authorize);
    const firstRes = buildRes();
    await handler({ query: {} } as never, firstRes, refreshJwt);
    expect(firstRes.status).toHaveBeenCalledWith(200);

    const revoked = await revokeViaReceiver(config, { sid: 'sid-3', sub: 'sub-3' });
    expect(revoked.status).toBe(200);

    const secondRes = buildRes();
    await handler({ query: {} } as never, secondRes, refreshJwt);
    expect(secondRes.status).toHaveBeenCalledWith(401);
    expect(secondRes.send).toHaveBeenCalledWith({ code: OPENID_SESSION_ENDED });
  });

  it('ends only the matching sid, leaving a second browser session for the same user active', async () => {
    const config = makeConfig();
    const authorizer = makeAuthorizer(config);
    const refA = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-browser-a' };
    const refB = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-browser-b' };

    await authorizer.establish({
      ref: refA,
      subject: 'sub-4',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });
    await authorizer.establish({
      ref: refB,
      subject: 'sub-4',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });

    const revoked = await revokeViaReceiver(config, { sid: 'sid-browser-a', sub: 'sub-4' });
    expect(revoked.status).toBe(200);

    await expect(
      authorizer.authorize({ ref: refA, subject: 'sub-4', expiresAt: future(), legacy: false }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
    await expect(
      authorizer.authorize({ ref: refB, subject: 'sub-4', expiresAt: future(), legacy: false }),
    ).resolves.toEqual({ ok: true });
  });

  it('ends every tenant-scoped session bound to the same provider session', async () => {
    const config = makeConfig();
    const authorizer = makeAuthorizer(config);
    const ref = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-shared' };
    const userA = new mongoose.Types.ObjectId().toString();
    const userB = new mongoose.Types.ObjectId().toString();
    const refreshJwtA = signRefreshJwt(userA);
    const refreshJwtB = signRefreshJwt(userB);

    await authorizer.establish({
      ref,
      subject: 'sub-5',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });
    await methods.upsertSession(userA, refreshJwtA, {
      expiration: future(),
      tenantId: 'org-a',
      providerSession: ref,
      authMethod: 'openid',
    });
    await methods.upsertSession(userB, refreshJwtB, {
      expiration: future(),
      tenantId: 'org-b',
      providerSession: ref,
      authMethod: 'openid',
    });

    const revoked = await revokeViaReceiver(config, { sid: 'sid-shared', sub: 'sub-5' });
    expect(revoked.status).toBe(200);

    const resA = buildRes();
    const resB = buildRes();
    await buildLocalHandler(authorizer.authorize)({ query: {} } as never, resA, refreshJwtA);
    await buildLocalHandler(authorizer.authorize)({ query: {} } as never, resB, refreshJwtB);

    expect(resA.status).toHaveBeenCalledWith(401);
    expect(resB.status).toHaveBeenCalledWith(401);
  });

  it('treats a duplicate logout notification as harmless and never shortens retention', async () => {
    const config = makeConfig();
    const authorizer = makeAuthorizer(config);
    const ref = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-dup' };
    await authorizer.establish({
      ref,
      subject: 'sub-6',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });

    const token = signLogoutToken({ sid: 'sid-dup', sub: 'sub-6' });
    const deps = {
      config,
      client: { issuer: ISSUER, clientId: CLIENT_ID },
      resolveKey: async () => keyPair.publicKey,
      revokeProviderSession: methods.revokeProviderSession,
      logger: makeLogger(),
    };

    const first = await receiveBackchannelLogout(token, deps);
    expect(first.status).toBe(200);
    const stored1 = await mongoose.models.ProviderSession.findOne(ref).lean<IProviderSession>();

    const second = await receiveBackchannelLogout(token, deps);
    expect(second.status).toBe(200);
    const stored2 = await mongoose.models.ProviderSession.findOne(ref).lean<IProviderSession>();

    expect(stored2?.revokedAt?.getTime()).toBe(stored1?.revokedAt?.getTime());
    expect(stored2?.expiresAt.getTime()).toBeGreaterThanOrEqual(stored1!.expiresAt.getTime());
    await expect(
      authorizer.authorize({ ref, subject: 'sub-6', expiresAt: future(), legacy: false }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
  });

  it('answers 503 and revokes nothing when the receiver cannot reach the database', async () => {
    const config = makeConfig();
    const failingRevoke = jest.fn().mockRejectedValue(new Error('connection reset'));
    const response = await revokeViaReceiver(config, { sid: 'sid-db-fail' }, failingRevoke);

    expect(response.status).toBe(503);
    if (response.status === 503) {
      expect(response.body).toEqual({ code: AUTH_SESSION_CHECK_UNAVAILABLE });
    }
    const stored = await mongoose.models.ProviderSession.findOne({ sid: 'sid-db-fail' }).lean();
    expect(stored).toBeNull();
  });

  it('performs no ProviderSession database operation when mode is off', async () => {
    const config = makeConfig({ mode: 'off' });
    const establishSpy = jest.fn(methods.establishProviderSession);
    const authorizeSpy = jest.fn(methods.authorizeProviderSession);
    const authorizer = createProviderSessionAuthorizer({
      methods: { establish: establishSpy, authorize: authorizeSpy },
      getConfig: () => Promise.resolve(config),
      logger: makeLogger(),
    });
    const ref = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-off' };

    await expect(
      authorizer.establish({ ref, expiresAt: future(), callbackIssuedAt: new Date() }),
    ).resolves.toEqual({ ok: true });
    await expect(
      authorizer.authorize({ ref, expiresAt: future(), legacy: false }),
    ).resolves.toEqual({ ok: true });

    expect(establishSpy).not.toHaveBeenCalled();
    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(isBackchannelLogoutEnabled(config, { issuer: ISSUER, clientId: CLIENT_ID })).toBe(false);
  });

  it('denies the pending login callback once logout ends the session before it completes', async () => {
    const config = makeConfig();
    const authorizer = makeAuthorizer(config);
    const ref = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-callback' };

    const revoked = await revokeViaReceiver(config, { sid: 'sid-callback', sub: 'sub-8' });
    expect(revoked.status).toBe(200);

    await expect(
      authorizer.establish({
        ref,
        subject: 'sub-8',
        expiresAt: future(),
        callbackIssuedAt: new Date(),
      }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
  });

  it('revokes only the tenant named by a logout token under a templated configured issuer, leaving the other tenant active', async () => {
    const config = makeConfig();
    const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    const tenantAIssuer = 'https://login.microsoftonline.com/tenant-a/v2.0';
    const tenantBIssuer = 'https://login.microsoftonline.com/tenant-b/v2.0';
    const authorizer = makeAuthorizer(config);
    const refA = { issuer: tenantAIssuer, clientId: CLIENT_ID, sid: 'sid-multi-tenant' };
    const refB = { issuer: tenantBIssuer, clientId: CLIENT_ID, sid: 'sid-multi-tenant' };

    await authorizer.establish({
      ref: refA,
      subject: 'sub-10',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });
    await authorizer.establish({
      ref: refB,
      subject: 'sub-10',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });

    const token = signLogoutToken({ sid: 'sid-multi-tenant', sub: 'sub-10', iss: tenantAIssuer });
    const revoked = await receiveBackchannelLogout(token, {
      config,
      client: { issuer: templateIssuer, clientId: CLIENT_ID },
      resolveKey: async () => keyPair.publicKey,
      revokeProviderSession: methods.revokeProviderSession,
      logger: makeLogger(),
    });
    expect(revoked.status).toBe(200);

    await expect(
      authorizer.authorize({ ref: refA, subject: 'sub-10', expiresAt: future(), legacy: false }),
    ).resolves.toEqual({ ok: false, code: OPENID_SESSION_ENDED });
    await expect(
      authorizer.authorize({ ref: refB, subject: 'sub-10', expiresAt: future(), legacy: false }),
    ).resolves.toEqual({ ok: true });
  });

  it('lets a later sign-in establish a fresh provider session returned by the provider', async () => {
    const config = makeConfig();
    const authorizer = makeAuthorizer(config);
    const endedRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-callback-2' };

    await revokeViaReceiver(config, { sid: 'sid-callback-2', sub: 'sub-9' });
    await authorizer.establish({
      ref: endedRef,
      subject: 'sub-9',
      expiresAt: future(),
      callbackIssuedAt: new Date(),
    });

    const freshRef = { issuer: ISSUER, clientId: CLIENT_ID, sid: 'sid-callback-2-new' };
    await expect(
      authorizer.establish({
        ref: freshRef,
        subject: 'sub-9',
        expiresAt: future(),
        callbackIssuedAt: new Date(),
      }),
    ).resolves.toEqual({ ok: true });
  });
});

/**
 * An operator rolling a misbehaving deployment back to `off` and later forward again must find
 * the same associations in place: a refresh taken while `off` must carry the bound ref forward
 * unchanged, not erase it.
 */
