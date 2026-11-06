import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { generateKeyPairSync } from 'crypto';
import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { ResolvedBackchannelLogoutConfig } from '../providerSession/config';
import type { CreateBackchannelLogoutHandlersOptions } from './handlers';
import { createBackchannelLogoutHandlers } from './handlers';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'librechat';
const CLIENT = { issuer: ISSUER, clientId: CLIENT_ID };
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function makeConfig(
  overrides: Partial<ResolvedBackchannelLogoutConfig> = {},
): ResolvedBackchannelLogoutConfig {
  return {
    mode: 'enforce',
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

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function signValidToken(overrides: Record<string, unknown> = {}): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: nowSec,
      jti: 'token-id-1',
      sid: 'session-1',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      ...overrides,
    },
    keyPair.privateKey,
    { algorithm: 'RS256', keyid: 'test-key-1' },
  );
}

function buildApp(options: CreateBackchannelLogoutHandlersOptions) {
  const { requireBackchannelLogoutEnabled, parseBackchannelLogoutBody, handleBackchannelLogout } =
    createBackchannelLogoutHandlers(options);
  const app = express();
  app.post(
    '/oauth/openid/backchannel-logout',
    requireBackchannelLogoutEnabled,
    parseBackchannelLogoutBody,
    handleBackchannelLogout,
  );
  app.use((_req: Request, res: Response) => {
    res.status(404).end();
  });
  return app;
}

describe('createBackchannelLogoutHandlers', () => {
  it('answers 503 when the config load fails, before parsing or revoking', async () => {
    const revokeProviderSession = jest.fn();
    const app = buildApp({
      getConfig: jest.fn().mockRejectedValue(new Error('load failed')),
      getClient: jest.fn().mockReturnValue(CLIENT),
      resolveKey: jest.fn(),
      revokeProviderSession,
      logger: makeLogger(),
    });

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('logout_token=anything');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: AUTH_SESSION_CHECK_UNAVAILABLE });
    expect(revokeProviderSession).not.toHaveBeenCalled();
  });

  it('falls through to the app default when disabled', async () => {
    const app = buildApp({
      getConfig: jest.fn().mockResolvedValue(makeConfig({ mode: 'off' })),
      getClient: jest.fn().mockReturnValue(CLIENT),
      resolveKey: jest.fn(),
      revokeProviderSession: jest.fn(),
      logger: makeLogger(),
    });

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send('logout_token=anything');

    expect(response.status).toBe(404);
  });

  it('sets Cache-Control: no-store and proceeds once enabled', async () => {
    const app = buildApp({
      getConfig: jest.fn().mockResolvedValue(makeConfig()),
      getClient: jest.fn().mockReturnValue(CLIENT),
      resolveKey: jest.fn().mockRejectedValue(new Error('key unavailable')),
      revokeProviderSession: jest.fn(),
      logger: makeLogger(),
    });

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({});

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers an empty 200 for a valid, successfully revoked token', async () => {
    const token = signValidToken({ sub: 'user-1' });
    const app = buildApp({
      getConfig: jest.fn().mockResolvedValue(makeConfig()),
      getClient: jest.fn().mockReturnValue(CLIENT),
      resolveKey: jest.fn().mockResolvedValue(publicKeyPem),
      revokeProviderSession: jest.fn().mockResolvedValue({ ok: true }),
      logger: makeLogger(),
    });

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send(`logout_token=${token}`);

    expect(response.status).toBe(200);
    expect(response.text).toBe('');
  });

  it('answers the mapped status and json body for a rejected token', async () => {
    const app = buildApp({
      getConfig: jest.fn().mockResolvedValue(makeConfig()),
      getClient: jest.fn().mockReturnValue(CLIENT),
      resolveKey: jest.fn(),
      revokeProviderSession: jest.fn(),
      logger: makeLogger(),
    });

    const response = await request(app)
      .post('/oauth/openid/backchannel-logout')
      .type('form')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('builds its JWKS resolver from getJwksUri only when resolveKey is not supplied', async () => {
    const getJwksUri = jest.fn().mockReturnValue('https://idp.example.com/jwks');
    expect(() =>
      createBackchannelLogoutHandlers({
        getConfig: jest.fn(),
        getClient: jest.fn(),
        getJwksUri,
        revokeProviderSession: jest.fn(),
        logger: makeLogger(),
      }),
    ).not.toThrow();
    expect(getJwksUri).not.toHaveBeenCalled();
  });
});
