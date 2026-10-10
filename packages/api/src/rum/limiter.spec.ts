jest.mock('~/app/metrics', () => ({
  recordRumProxyRequest: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { createRumProxyLimiter, getRumProxyUserMax, getRumProxyUserWindowMs } from './limiter';
import { recordRumProxyRequest } from '~/app/metrics';

type TestUser = { id: string; tenantId?: string };

function authenticateFromHeaders(req: Request, _res: Response, next: NextFunction) {
  const user: TestUser = {
    id: String(req.headers['x-user'] ?? ''),
    tenantId: req.headers['x-tenant'] ? String(req.headers['x-tenant']) : undefined,
  };
  (req as ServerRequest).user = user as ServerRequest['user'];
  next();
}

function createApp() {
  const app = express();
  const forwarded = jest.fn((_req: Request, res: Response) => {
    res.status(200).json({});
  });
  app.post('/v1/:signal', authenticateFromHeaders, createRumProxyLimiter(), forwarded);
  return { app, forwarded };
}

describe('RUM proxy per-user limiter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.mocked(recordRumProxyRequest).mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to 240 requests per user per minute and ignores invalid overrides', () => {
    delete process.env.RUM_PROXY_USER_MAX;
    delete process.env.RUM_PROXY_USER_WINDOW;
    expect(getRumProxyUserMax()).toBe(240);
    expect(getRumProxyUserWindowMs()).toBe(60_000);

    process.env.RUM_PROXY_USER_MAX = '0';
    process.env.RUM_PROXY_USER_WINDOW = 'soon';
    expect(getRumProxyUserMax()).toBe(240);
    expect(getRumProxyUserWindowMs()).toBe(60_000);

    process.env.RUM_PROXY_USER_MAX = '0.5';
    expect(getRumProxyUserMax()).toBe(240);

    process.env.RUM_PROXY_USER_MAX = '30';
    process.env.RUM_PROXY_USER_WINDOW = '5';
    expect(getRumProxyUserMax()).toBe(30);
    expect(getRumProxyUserWindowMs()).toBe(300_000);
  });

  it('answers 429 once a user exceeds the budget, without reaching the collector', async () => {
    process.env.RUM_PROXY_USER_MAX = '2';
    const { app, forwarded } = createApp();

    const send = (signal: string) =>
      request(app).post(`/v1/${signal}`).set('x-user', 'user-a').send();

    expect((await send('traces')).status).toBe(200);
    expect((await send('logs')).status).toBe(200);
    const limited = await send('logs');

    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(forwarded).toHaveBeenCalledTimes(2);
    expect(recordRumProxyRequest).toHaveBeenCalledWith('logs', 'rate_limited');
  });

  it('keeps separate buckets per user and per tenant', async () => {
    process.env.RUM_PROXY_USER_MAX = '1';
    const { app } = createApp();

    const send = (user: string, tenant?: string) => {
      const req = request(app).post('/v1/logs').set('x-user', user);
      return (tenant ? req.set('x-tenant', tenant) : req).send();
    };

    expect((await send('user-a', 'tenant-1')).status).toBe(200);
    expect((await send('user-a', 'tenant-1')).status).toBe(429);
    expect((await send('user-a', 'tenant-2')).status).toBe(200);
    expect((await send('user-b', 'tenant-1')).status).toBe(200);
    expect((await send('user-a')).status).toBe(200);
  });
});
