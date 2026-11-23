import IoRedis from 'ioredis';
import express from 'express';
import request from 'supertest';
import { createClient } from '@keyv/redis';
import type { RedisClientType } from '@redis/client';
import type { Request, Response } from 'express';
import type { RespServer } from '~/cache/__tests__/resp.helper';
import type { RedisReadinessClients } from './readiness';
import { createReadinessHandler, createStartupReadiness, isRedisReady } from './readiness';
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
  const probe = (serverReady: boolean, redis: RedisReadinessClients) =>
    respond(createReadinessHandler(() => serverReady, redis));

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

describe('worker startup readiness', () => {
  const worker = (redis: RedisReadinessClients = clients({ useRedis: false })) => {
    const readiness = createStartupReadiness(redis);
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
});
