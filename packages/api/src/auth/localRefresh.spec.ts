import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import { createOpenIDSessionCache } from './openid/sessions';
import { createLocalRefreshHandler } from './localRefresh';

const JWT_REFRESH_SECRET = 'test-refresh-secret';

describe('createLocalRefreshHandler', () => {
  const previousEnv = process.env.JWT_REFRESH_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;
  });

  afterAll(() => {
    process.env.JWT_REFRESH_SECRET = previousEnv;
    process.env.NODE_ENV = previousNodeEnv;
  });

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  function buildRefreshToken(userId: string) {
    return jwt.sign({ id: userId }, JWT_REFRESH_SECRET);
  }

  function buildRes() {
    const res: Record<string, jest.Mock> = {};
    res.status = jest.fn(() => res);
    res.send = jest.fn(() => res);
    res.redirect = jest.fn(() => res);
    res.clearCookie = jest.fn(() => res);
    return res as unknown as import('express').Response;
  }

  function setup({ enforcement = false, timeoutMs = 1000 } = {}) {
    const authorization = {
      findOpenIDSession: jest.fn(),
      findOpenIDSessionById: jest.fn(),
      findOpenIDSubject: jest.fn(),
      findOpenIDBinding: jest.fn(),
      findOpenIDBindingBySid: jest.fn(),
    };
    const deps = {
      userProjection: '-password',
      getUserById: jest.fn(),
      findSession: jest.fn(),
      setAuthTokens: jest.fn().mockResolvedValue('app-token'),
      deleteSession: jest.fn(),
      deleteAllUserSessions: jest.fn(),
      clearCloudFrontCookies: jest.fn(),
      clearOpenIDAuthTokens: jest.fn(),
      getOpenIdClientId: jest.fn(() => 'client'),
      sessionAuthorization: {
        authorization,
        enforcement,
        timeoutMs,
        cache: createOpenIDSessionCache(),
      },
      warn: jest.fn(),
      error: jest.fn(),
    };
    const handler = createLocalRefreshHandler(deps);
    return { deps, handler, authorization };
  }

  it('mints a bearer without OpenID claims for a local (non-OpenID) user', async () => {
    const { deps, handler } = setup();
    const userId = 'user-1';
    deps.getUserById.mockResolvedValue({ _id: userId, provider: 'local' });
    deps.findSession.mockResolvedValue({
      _id: 'session-1',
      expiration: new Date(Date.now() + 60_000),
    });
    const req = { headers: {} } as unknown as import('express').Request;
    const res = buildRes();

    await handler(req, res, buildRefreshToken(userId));

    expect(deps.setAuthTokens).toHaveBeenCalledWith(
      userId,
      res,
      expect.objectContaining({ _id: 'session-1' }),
      req,
      undefined,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('authorizes an OpenID-backed session and carries its claims into the minted bearer', async () => {
    const { deps, handler, authorization } = setup({ enforcement: true });
    const userId = 'user-2';
    deps.getUserById.mockResolvedValue({
      _id: userId,
      provider: 'openid',
      tenantId: 'tenant-1',
      openidId: 'subject-1',
      openidIssuer: 'https://issuer.example.com',
    });
    deps.findSession.mockResolvedValue({
      _id: 'session-2',
      expiration: new Date(Date.now() + 60_000),
      openidSessionId: 'sid-1',
    });
    authorization.findOpenIDSessionById.mockResolvedValue({
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      clientId: 'client',
      revokedAt: null,
    });
    authorization.findOpenIDSubject.mockResolvedValue({ boundaryIat: null });
    authorization.findOpenIDBinding.mockResolvedValue({ id: 'binding-1' });
    const req = { headers: {} } as unknown as import('express').Request;
    const res = buildRes();

    await handler(req, res, buildRefreshToken(userId));

    expect(deps.setAuthTokens).toHaveBeenCalledWith(
      userId,
      res,
      expect.objectContaining({ _id: 'session-2' }),
      req,
      { openidSessionId: 'sid-1', tenantId: 'tenant-1' },
    );
    expect(deps.clearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('denies and clears cookies when the OpenID session is revoked', async () => {
    const { deps, handler, authorization } = setup({ enforcement: true });
    const userId = 'user-3';
    deps.getUserById.mockResolvedValue({
      _id: userId,
      provider: 'openid',
      tenantId: 'tenant-1',
      openidId: 'subject-1',
      openidIssuer: 'https://issuer.example.com',
    });
    deps.findSession.mockResolvedValue({
      _id: 'session-3',
      expiration: new Date(Date.now() + 60_000),
      openidSessionId: 'sid-1',
    });
    authorization.findOpenIDSessionById.mockResolvedValue({
      subject: 'subject-1',
      issuer: 'https://issuer.example.com',
      clientId: 'client',
      revokedAt: new Date(),
    });
    authorization.findOpenIDSubject.mockResolvedValue(null);
    authorization.findOpenIDBinding.mockResolvedValue({ id: 'binding-1' });
    const req = { headers: {} } as unknown as import('express').Request;
    const res = buildRes();

    await handler(req, res, buildRefreshToken(userId));

    expect(deps.setAuthTokens).not.toHaveBeenCalled();
    expect(deps.clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, userId, 'tenant-1');
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 503 and keeps cookies when authorization reads are unavailable', async () => {
    const { deps, handler, authorization } = setup({ enforcement: true, timeoutMs: 5 });
    const userId = 'user-4';
    deps.getUserById.mockResolvedValue({
      _id: userId,
      provider: 'openid',
      tenantId: 'tenant-1',
      openidId: 'subject-1',
      openidIssuer: 'https://issuer.example.com',
    });
    deps.findSession.mockResolvedValue({
      _id: 'session-4',
      expiration: new Date(Date.now() + 60_000),
      openidSessionId: 'sid-1',
    });
    authorization.findOpenIDSessionById.mockImplementation(() => new Promise(() => {}));
    authorization.findOpenIDSubject.mockImplementation(() => new Promise(() => {}));
    const req = { headers: {} } as unknown as import('express').Request;
    const res = buildRes();

    await handler(req, res, buildRefreshToken(userId));

    expect(deps.setAuthTokens).not.toHaveBeenCalled();
    expect(deps.clearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

describe('createLocalRefreshHandler - session reference from login', () => {
  let mongo: MongoMemoryServer;
  let methods: ReturnType<typeof createMethods>;
  const previousNodeEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(mongo.getUri());
    methods = createMethods(mongoose);
  }, 30_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    process.env.NODE_ENV = previousNodeEnv;
  });

  // The suite's CI job sets NODE_ENV=CI, which hits the handler's CI short-circuit; isolate it like the block above.
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  /** Login records `openidSessionId` on the session; refresh must read and reauthorize it. */
  it('authorizes a non-reuse-mode refresh with the openidSessionId recorded at login', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const openidSessionId = new mongoose.Types.ObjectId().toString();
    const { session, refreshToken } = await methods.createSession(userId, {
      openidSessionId,
    });

    const authorization = {
      findOpenIDSession: jest.fn(),
      findOpenIDSessionById: jest.fn().mockResolvedValue({
        subject: 'subject-1',
        issuer: 'https://issuer.example.com',
        clientId: 'client',
        revokedAt: null,
      }),
      findOpenIDSubject: jest.fn().mockResolvedValue({ boundaryIat: null }),
      findOpenIDBinding: jest.fn().mockResolvedValue({ id: 'binding-1' }),
      findOpenIDBindingBySid: jest.fn(),
    };
    const deps = {
      userProjection: '-password',
      getUserById: jest.fn().mockResolvedValue({
        _id: userId,
        provider: 'openid',
        tenantId: 'tenant-1',
        openidId: 'subject-1',
        openidIssuer: 'https://issuer.example.com',
      }),
      findSession: methods.findSession,
      setAuthTokens: jest.fn().mockResolvedValue('app-token'),
      deleteSession: jest.fn(),
      deleteAllUserSessions: jest.fn(),
      clearCloudFrontCookies: jest.fn(),
      clearOpenIDAuthTokens: jest.fn(),
      getOpenIdClientId: jest.fn(() => 'client'),
      sessionAuthorization: {
        authorization,
        enforcement: true,
        timeoutMs: 1000,
        cache: createOpenIDSessionCache(),
      },
      warn: jest.fn(),
      error: jest.fn(),
    };
    const handler = createLocalRefreshHandler(deps);
    const req = { headers: {} } as unknown as import('express').Request;
    const res = {
      status: jest.fn(() => res),
      send: jest.fn(() => res),
      redirect: jest.fn(() => res),
      clearCookie: jest.fn(() => res),
    } as unknown as import('express').Response;

    expect(String(session.openidSessionId)).toBe(openidSessionId);

    await handler(req, res, refreshToken);

    expect(authorization.findOpenIDSessionById).toHaveBeenCalledWith(openidSessionId);
    expect(deps.setAuthTokens).toHaveBeenCalledWith(userId, res, expect.anything(), req, {
      openidSessionId,
      tenantId: 'tenant-1',
    });
    const setAuthTokensSession = deps.setAuthTokens.mock.calls[0][2];
    expect(String(setAuthTokensSession.openidSessionId)).toBe(openidSessionId);
    expect(deps.clearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
