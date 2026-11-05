import express from 'express';
import request from 'supertest';
import {
  generateKeyPair,
  SignJWT,
  exportJWK,
  calculateJwkThumbprint,
  createLocalJWKSet,
} from 'jose';
import type { Response } from 'express';
import type { KeyLike } from 'jose';

/** Swaps the remote JWKS fetch for a local keyset so these tests never make a network call. */
const mockCreateIssuerJwksGetKey = jest.fn();
jest.mock('./jwks', () => ({
  createIssuerJwksGetKey: (...args: unknown[]) => mockCreateIssuerJwksGetKey(...args),
}));

import { createOpenIDBackchannelLogoutRuntime } from './backchannel';
import { createBackchannelLogoutBodyParser } from './logout/receiver';
import type { OpenIDBackchannelLogoutConfig, OpenIDBackchannelLogoutRuntime } from './backchannel';

const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function fakeRes() {
  const res = {} as Response;
  res.status = jest.fn(() => res) as unknown as Response['status'];
  res.end = jest.fn() as unknown as Response['end'];
  return res;
}

function buildRuntime(
  overrides: {
    getOpenIdConfig?: () => OpenIDBackchannelLogoutConfig | undefined;
    connectOpenIDAuthorization?: jest.Mock;
    getAuthorizationMethods?: jest.Mock;
    getLeaseMethods?: jest.Mock;
  } = {},
) {
  return createOpenIDBackchannelLogoutRuntime({
    getOpenIdConfig: overrides.getOpenIdConfig ?? (() => undefined),
    connectOpenIDAuthorization:
      overrides.connectOpenIDAuthorization ?? jest.fn().mockResolvedValue(undefined),
    getAuthorizationMethods:
      overrides.getAuthorizationMethods ?? jest.fn().mockReturnValue(undefined),
    getLeaseMethods: overrides.getLeaseMethods ?? jest.fn().mockReturnValue(undefined),
    logger: mockLogger,
  });
}

describe('initOpenIDBackchannelLogout with discovery not ready at startup', () => {
  const issuer = 'https://issuer.example.com';
  const clientId = 'discovery-test-client';
  let privateKey: KeyLike;
  let getKey: ReturnType<typeof createLocalJWKSet>;
  let kid: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const jwk = await exportJWK(keyPair.publicKey);
    kid = await calculateJwkThumbprint(jwk);
    getKey = createLocalJWKSet({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
  }, 30_000);

  beforeEach(() => {
    process.env.OPENID_CLIENT_ID = clientId;
    jest.clearAllMocks();
    mockCreateIssuerJwksGetKey.mockReturnValue(getKey);
  });

  afterEach(() => {
    delete process.env.OPENID_CLIENT_ID;
  });

  async function signLogoutToken({ sid, jti }: { sid: string; jti: string }) {
    return new SignJWT({ sub: 'subject-1', sid, events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(jti)
      .sign(privateKey);
  }

  it('builds a live receiver that answers 500, not the 404 disabled stub, while discovery fails', async () => {
    const getOpenIdConfig = jest.fn(() => {
      throw new Error('discovery not ready');
    });
    const runtime = buildRuntime({
      getOpenIdConfig,
      connectOpenIDAuthorization: jest.fn().mockResolvedValue({}),
    });
    await runtime.initOpenIDBackchannelLogout({
      registration: { openidBackchannelLogout: true, openidSessionEnforcement: true },
    });
    const receiver = runtime.getReceiver()!;
    const req = { body: { logout_token: await signLogoutToken({ sid: 'sid-1', jti: 'jti-1' }) } };
    const res = fakeRes();

    await receiver(req as never, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it('creates the worker even though discovery failed at init', async () => {
    const getOpenIdConfig = jest.fn(() => {
      throw new Error('discovery not ready');
    });
    const runtime = buildRuntime({
      getOpenIdConfig,
      connectOpenIDAuthorization: jest.fn().mockResolvedValue({}),
    });
    await runtime.initOpenIDBackchannelLogout({
      registration: { openidBackchannelLogout: true, openidSessionEnforcement: true },
    });

    expect(() => runtime.startOpenIDBackchannelLogoutWorker()).not.toThrow();
  });

  it('verifies the request once discovery becomes ready, without rebuilding the receiver', async () => {
    const getOpenIdConfig: jest.Mock<OpenIDBackchannelLogoutConfig | undefined, []> = jest.fn(
      () => {
        throw new Error('discovery not ready');
      },
    );
    const getAuthorizationMethods = jest.fn().mockReturnValue({
      recordOpenIDLogoutEvent: jest.fn().mockResolvedValue({
        event: { state: 'received', sid: 'sid-1', issuer, clientId, receivedAt: new Date() },
      }),
      upsertOpenIDSubjectBoundary: jest.fn().mockResolvedValue(undefined),
      recordOpenIDLogout: jest.fn().mockResolvedValue(undefined),
      markOpenIDLogoutEventEnforced: jest.fn().mockResolvedValue(undefined),
    });
    const runtime = buildRuntime({
      getOpenIdConfig,
      connectOpenIDAuthorization: jest.fn().mockResolvedValue({}),
      getAuthorizationMethods,
    });
    await runtime.initOpenIDBackchannelLogout({
      registration: { openidBackchannelLogout: true, openidSessionEnforcement: true },
    });
    const receiver = runtime.getReceiver()!;

    const pendingReq = {
      body: { logout_token: await signLogoutToken({ sid: 'sid-1', jti: 'jti-1' }) },
    };
    const pendingRes = fakeRes();
    await receiver(pendingReq as never, pendingRes, jest.fn());
    expect(pendingRes.status).toHaveBeenCalledWith(500);

    getOpenIdConfig.mockImplementation(() => ({
      clientMetadata: () => ({}),
      serverMetadata: () => ({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
      }),
    }));

    const readyReq = {
      body: { logout_token: await signLogoutToken({ sid: 'sid-2', jti: 'jti-2' }) },
    };
    const readyRes = fakeRes();
    await receiver(readyReq as never, readyRes, jest.fn());

    expect(readyRes.status).toHaveBeenCalledWith(200);
  });
});

describe('initOpenIDBackchannelLogout with the authorization connection pending at startup', () => {
  const issuer = 'https://issuer.example.com';
  const clientId = 'lazy-test-client';
  let privateKey: KeyLike;
  let getKey: ReturnType<typeof createLocalJWKSet>;
  let kid: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    const jwk = await exportJWK(keyPair.publicKey);
    kid = await calculateJwkThumbprint(jwk);
    getKey = createLocalJWKSet({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
  }, 30_000);

  beforeEach(() => {
    process.env.OPENID_CLIENT_ID = clientId;
    jest.clearAllMocks();
    mockCreateIssuerJwksGetKey.mockReturnValue(getKey);
  });

  afterEach(() => {
    delete process.env.OPENID_CLIENT_ID;
  });

  async function signLogoutToken({ sid, jti }: { sid: string; jti: string }) {
    return new SignJWT({ sub: 'subject-1', sid, events: { [BACKCHANNEL_LOGOUT_EVENT]: {} } })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti(jti)
      .sign(privateKey);
  }

  function pendingRuntime(getAuthorizationMethods = jest.fn().mockReturnValue(undefined)) {
    return buildRuntime({
      getOpenIdConfig: () => ({
        clientMetadata: () => ({}),
        serverMetadata: () => ({
          issuer,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      }),
      connectOpenIDAuthorization: jest.fn().mockResolvedValue(undefined),
      getAuthorizationMethods,
    });
  }

  it('builds a live receiver that answers 500, not the 404 disabled stub', async () => {
    const runtime = pendingRuntime();
    await runtime.initOpenIDBackchannelLogout({
      registration: { openidBackchannelLogout: true, openidSessionEnforcement: true },
    });
    const receiver = runtime.getReceiver()!;
    const req = { body: { logout_token: await signLogoutToken({ sid: 'sid-1', jti: 'jti-1' }) } };
    const res = fakeRes();

    await receiver(req as never, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  it('starts enforcing once the connection comes up, without rebuilding the receiver', async () => {
    const getAuthorizationMethods = jest.fn().mockReturnValue(undefined);
    const runtime = pendingRuntime(getAuthorizationMethods);
    await runtime.initOpenIDBackchannelLogout({
      registration: { openidBackchannelLogout: true, openidSessionEnforcement: true },
    });
    const receiver = runtime.getReceiver()!;

    const methods = {
      recordOpenIDLogoutEvent: jest.fn().mockResolvedValue({
        event: { state: 'received', sid: 'sid-2', issuer, clientId, receivedAt: new Date() },
      }),
      upsertOpenIDSubjectBoundary: jest.fn().mockResolvedValue(undefined),
      recordOpenIDLogout: jest.fn().mockResolvedValue(undefined),
      markOpenIDLogoutEventEnforced: jest.fn().mockResolvedValue(undefined),
    };
    getAuthorizationMethods.mockReturnValue(methods);

    const req = { body: { logout_token: await signLogoutToken({ sid: 'sid-2', jti: 'jti-2' }) } };
    const res = fakeRes();

    await receiver(req as never, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(methods.recordOpenIDLogoutEvent).toHaveBeenCalled();
    expect(methods.markOpenIDLogoutEventEnforced).toHaveBeenCalled();
  });

  it('the worker skips the round instead of crashing while the connection is pending', async () => {
    jest.useFakeTimers();
    const runtime = pendingRuntime();
    await runtime.initOpenIDBackchannelLogout({
      registration: { openidBackchannelLogout: true, openidSessionEnforcement: true },
    });

    expect(() => runtime.startOpenIDBackchannelLogoutWorker()).not.toThrow();
    await jest.runOnlyPendingTimersAsync();

    jest.useRealTimers();
  });
});

describe('createRouteMiddleware, mounted ahead of global middleware', () => {
  let runtime: OpenIDBackchannelLogoutRuntime;

  function buildApp() {
    const app = express();
    app.post('/oauth/openid/backchannel-logout', ...runtime.createRouteMiddleware());
    app.use(express.json({ limit: '3mb' }));
    app.use(express.urlencoded({ extended: true, limit: '3mb' }));
    app.use((req, res, next) => {
      res.cookie('connect.sid', 'fake-session');
      next();
    });
    const notFound: express.RequestHandler = (_req, res) => {
      res.status(404).end();
    };
    app.use(notFound);
    app.use((err: { status?: number }, req: express.Request, res: express.Response) => {
      res.status(err.status ?? 500).end();
    });
    return app;
  }

  beforeEach(() => {
    runtime = buildRuntime();
    runtime.getRateLimiter = jest.fn().mockReturnValue(undefined);
    runtime.getBodyParser = jest.fn().mockReturnValue(createBackchannelLogoutBodyParser());
    runtime.getReceiver = jest.fn().mockReturnValue(undefined);
  });

  it('returns 404 and sets no session cookie when the receiver is disabled', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({ logout_token: 'anything' });
    expect(response.status).toBe(404);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a body over the 8 KB limit with 413 before the global body parsers or session middleware run', async () => {
    runtime.getReceiver = jest
      .fn()
      .mockReturnValue((_req: never, res: Response) => res.status(200).end());
    const app = buildApp();
    const oversizedBody = 'logout_token=' + 'a'.repeat(9 * 1024);
    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send(oversizedBody);
    expect(response.status).toBe(413);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('runs the rate limiter before the body parser and receiver', async () => {
    const order: string[] = [];
    runtime.getRateLimiter = jest
      .fn()
      .mockReturnValue((_req: never, _res: never, next: () => void) => {
        order.push('rateLimiter');
        next();
      });
    runtime.getReceiver = jest.fn().mockReturnValue((_req: never, res: Response) => {
      order.push('receiver');
      res.status(200).end();
    });
    const app = buildApp();
    await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({ logout_token: 'small' })
      .expect(200);
    expect(order).toEqual(['rateLimiter', 'receiver']);
  });

  it('short-circuits with 429 from the rate limiter before reaching the receiver', async () => {
    runtime.getRateLimiter = jest
      .fn()
      .mockReturnValue((_req: never, res: Response) => res.status(429).end());
    const receiver = jest.fn((_req: never, res: Response) => res.status(200).end());
    runtime.getReceiver = jest.fn().mockReturnValue(receiver);
    const app = buildApp();
    await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({ logout_token: 'small' })
      .expect(429);
    expect(receiver).not.toHaveBeenCalled();
  });

  it('accepts a body under the limit and reaches the receiver with no session cookie set', async () => {
    const receiver = jest.fn((_req: never, res: Response) => res.status(200).end());
    runtime.getReceiver = jest.fn().mockReturnValue(receiver);
    const app = buildApp();
    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({ logout_token: 'small' });
    expect(response.status).toBe(200);
    expect(receiver).toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
