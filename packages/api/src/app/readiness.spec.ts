import IoRedis from 'ioredis';
import express from 'express';
import request from 'supertest';
import { createClient } from '@keyv/redis';
import { logger } from '@librechat/data-schemas';
import type { RedisClientType } from '@redis/client';
import type { Request, Response } from 'express';
import type { RespServer } from '~/cache/__tests__/resp.helper';
import type { RedisReadinessClients } from './readiness';
import type { ReadinessOptions } from './readiness';
import {
  createOpenIdReadiness,
  createReadinessHandler,
  createServerReadinessSettings,
  createStartupReadiness,
  isRedisReady,
} from './readiness';
import { startRespServer, waitFor } from '~/cache/__tests__/resp.helper';

const clients = (overrides: Partial<RedisReadinessClients> = {}): RedisReadinessClients => ({
  useRedis: true,
  ioredis: { status: 'ready' },
  keyv: { isReady: true },
  ...overrides,
});

describe('isRedisReady', () => {
  it('is ready when Redis is disabled, even without clients', () => {
    expect(isRedisReady({ useRedis: false, ioredis: null, keyv: null })).toBe(true);
  });

  it('is ready when both clients are connected', () => {
    expect(isRedisReady(clients())).toBe(true);
  });

  it.each(['connecting', 'reconnecting', 'close', 'end', 'wait'] as const)(
    'is not ready when ioredis is %s',
    (status) => {
      expect(isRedisReady(clients({ ioredis: { status } }))).toBe(false);
    },
  );

  it('is not ready when the Keyv client is disconnected', () => {
    expect(isRedisReady(clients({ keyv: { isReady: false } }))).toBe(false);
  });

  it('is not ready when a configured client is missing', () => {
    expect(isRedisReady(clients({ ioredis: null }))).toBe(false);
    expect(isRedisReady(clients({ keyv: null }))).toBe(false);
  });

  it('requires every master of a Keyv cluster to be ready', () => {
    const ready = { isReady: true };
    const down = { isReady: false };
    const cluster = (isOpen: boolean, masters: { client?: { isReady: boolean } }[]) =>
      isRedisReady(clients({ keyv: { isOpen, masters } }));

    expect(cluster(true, [{ client: ready }, { client: ready }])).toBe(true);
    expect(cluster(true, [{ client: ready }, { client: down }])).toBe(false);
    expect(cluster(true, [{ client: ready }, {}])).toBe(false);
    expect(cluster(true, [])).toBe(false);
    expect(cluster(false, [{ client: ready }])).toBe(false);
  });
});

describe('isRedisReady with live clients', () => {
  let server: RespServer;
  let ioredis: IoRedis;
  let keyv: RedisClientType;

  afterEach(async () => {
    ioredis?.disconnect();
    if (keyv?.isOpen) {
      keyv.destroy();
    }
    await server?.close();
  });

  it('turns not ready when Redis goes away and ready again once it returns', async () => {
    server = await startRespServer();
    const { port, url } = server;
    ioredis = new IoRedis(url, { retryStrategy: () => 20, maxRetriesPerRequest: 0 });
    ioredis.on('error', () => undefined);
    keyv = createClient({ url, socket: { reconnectStrategy: () => 20 } }) as RedisClientType;
    keyv.on('error', () => undefined);
    await keyv.connect();
    await waitFor(() => ioredis.status === 'ready');

    const live = (): RedisReadinessClients => ({ useRedis: true, ioredis, keyv });
    expect(isRedisReady(live())).toBe(true);

    await server.close();
    await waitFor(() => !isRedisReady(live()));
    expect(ioredis.status).not.toBe('ready');

    server = await startRespServer(port);
    await waitFor(() => isRedisReady(live()), 5000);
  });
});

describe('createReadinessHandler', () => {
  const respond = (handler: ReturnType<typeof createReadinessHandler>) => {
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    handler({} as Request, res as unknown as Response);
    return { code: res.status.mock.calls[0][0], body: res.send.mock.calls[0][0] };
  };
  const probe = (
    serverReady: boolean,
    redis: RedisReadinessClients,
    options: ReadinessOptions = {},
  ) => respond(createReadinessHandler(() => serverReady, redis, options));

  it('returns 503 before startup completes', () => {
    expect(probe(false, clients())).toEqual({ code: 503, body: 'NOT_READY' });
  });

  it('returns 503 after startup when Redis drops', () => {
    expect(probe(true, clients({ ioredis: { status: 'reconnecting' } }))).toEqual({
      code: 503,
      body: 'NOT_READY',
    });
  });

  it('returns 200 when started and Redis is connected', () => {
    expect(probe(true, clients())).toEqual({ code: 200, body: 'OK' });
  });

  it('returns 200 when started with Redis disabled', () => {
    expect(probe(true, { useRedis: false, ioredis: null, keyv: null })).toEqual({
      code: 200,
      body: 'OK',
    });
  });

  it('can opt out of Redis and gate readiness on OIDC', () => {
    expect(
      probe(true, clients({ ioredis: { status: 'reconnecting' } }), {
        checks: { redis: false, oidc: true },
        isOpenIdReady: () => false,
      }),
    ).toEqual({ code: 503, body: 'NOT_READY' });
    expect(
      probe(true, clients({ ioredis: { status: 'reconnecting' } }), {
        checks: { redis: false, oidc: true },
        isOpenIdReady: () => true,
      }),
    ).toEqual({ code: 200, body: 'OK' });
  });

  it('re-evaluates readiness on every request', () => {
    const keyv = { isReady: true };
    const handler = createReadinessHandler(() => true, clients({ keyv }));
    expect(respond(handler).code).toBe(200);
    keyv.isReady = false;
    expect(respond(handler).code).toBe(503);
    keyv.isReady = true;
    expect(respond(handler).code).toBe(200);
  });
});

describe('OpenID readiness state', () => {
  afterEach(() => jest.restoreAllMocks());

  it('remains unready during registration and becomes ready after recovery', () => {
    const readiness = createOpenIdReadiness(true);
    expect(readiness.isReady()).toBe(false);
    readiness.markReady();
    expect(readiness.isReady()).toBe(true);
  });

  it('warns and passes when OpenID is not configured', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { checks, openIdReadiness } = createServerReadinessSettings(
      { server: { readiness: { checks: { oidc: true } } } },
      { socialLoginEnabled: true, usePkce: false },
    );

    expect(checks).toEqual({ redis: true, oidc: true });
    expect(openIdReadiness.isReady()).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[readiness] The OIDC readiness check is enabled, but OpenID login is disabled or not configured; skipping the check.',
    );
  });

  it('uses configured checks and waits for OpenID registration when login is configured', () => {
    const settings = createServerReadinessSettings(
      { server: { readiness: { checks: { redis: false, oidc: true } } } },
      {
        socialLoginEnabled: true,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        issuer: 'https://issuer.example.com',
        scope: 'openid profile email',
        sessionSecret: 'session-secret',
        usePkce: false,
      },
    );

    expect(settings.checks).toEqual({ redis: false, oidc: true });
    expect(settings.openIdReadiness.isReady()).toBe(false);
    settings.openIdReadiness.markReady();
    expect(settings.openIdReadiness.isReady()).toBe(true);
  });

  it('does not gate readiness when OIDC is not selected', () => {
    const readiness = createOpenIdReadiness(false);
    expect(readiness.isReady()).toBe(true);
  });
});

describe('worker startup readiness', () => {
  const worker = (
    redis: RedisReadinessClients = clients({ useRedis: false }),
    options: ReadinessOptions = {},
  ) => {
    const readiness = createStartupReadiness(redis, options);
    const app = express();
    app.get('/readyz', readiness.handler);
    app.use('/api', readiness.gate);
    app.get('/api/work', (_req, res) => {
      res.sendStatus(200);
    });
    return { app, readiness };
  };

  it('refuses API work until post-listen initialization completes', async () => {
    const { app, readiness } = worker();
    await request(app).get('/readyz').expect(503);
    await request(app)
      .get('/api/work')
      .expect('Retry-After', '1')
      .expect(503)
      .expect(({ body }) => expect(body.code).toBe('SERVER_NOT_READY'));
    readiness.markReady();
    await request(app).get('/readyz').expect(200);
    await request(app).get('/api/work').expect(200);
  });

  it('keeps another starting worker closed when its sibling becomes ready', async () => {
    const first = worker();
    const second = worker();
    first.readiness.markReady();
    await request(first.app).get('/api/work').expect(200);
    expect((await request(second.app).get('/readyz')).status).toBe(503);
    await request(second.app).get('/api/work').expect(503);
  });

  it('rechecks Redis readiness for both the probe and API admission', async () => {
    const keyv = { isReady: true };
    const { app, readiness } = worker(clients({ keyv }));
    readiness.markReady();
    await request(app).get('/api/work').expect(200);
    keyv.isReady = false;
    expect((await request(app).get('/readyz')).status).toBe(503);
    await request(app).get('/api/work').expect(503);
    keyv.isReady = true;
    await request(app).get('/readyz').expect(200);
    await request(app).get('/api/work').expect(200);
  });

  it('keeps API work closed until selected OIDC readiness recovers', async () => {
    const openIdReadiness = createOpenIdReadiness(true);
    const { app, readiness } = worker(clients({ useRedis: false }), {
      checks: { redis: true, oidc: true },
      isOpenIdReady: openIdReadiness.isReady,
    });
    readiness.markReady();

    expect((await request(app).get('/readyz')).status).toBe(503);
    expect((await request(app).get('/api/work')).status).toBe(503);

    openIdReadiness.markReady();
    expect((await request(app).get('/readyz')).status).toBe(200);
    expect((await request(app).get('/api/work')).status).toBe(200);
  });
});
