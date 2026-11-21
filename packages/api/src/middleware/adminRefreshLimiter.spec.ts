import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import { logger } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import { createAdminRefreshLimiter } from './adminRefreshLimiter';

function createApp(config = {}) {
  const app = express();
  app.set('trust proxy', 1);
  const getAppConfig = jest.fn(
    async () => ({ config: { rateLimits: { adminRefresh: config } } }) as AppConfig,
  );
  app.post('/login', rateLimit({ windowMs: 300_000, max: 7 }), (_req, res) => {
    res.sendStatus(204);
  });
  app.post('/refresh', createAdminRefreshLimiter({ getAppConfig }), (_req, res) => {
    res.sendStatus(204);
  });
  return { app, getAppConfig };
}

describe('createAdminRefreshLimiter', () => {
  it('retries a failed config load on the next request', async () => {
    const getAppConfig = jest
      .fn()
      .mockRejectedValueOnce(new Error('config unavailable'))
      .mockResolvedValue({ config: {} });
    const app = express();
    app.post('/refresh', createAdminRefreshLimiter({ getAppConfig }), (_req, res) => {
      res.sendStatus(204);
    });
    const errorHandler: express.ErrorRequestHandler = (_error, _req, res, _next) => {
      res.sendStatus(503);
    };
    app.use(errorHandler);
    await request(app).post('/refresh').expect(503);
    await request(app).post('/refresh').expect(204);
    expect(getAppConfig).toHaveBeenCalledTimes(2);
  });

  it('allows ordinary page reloads without spending the sign-in budget', async () => {
    const { app, getAppConfig } = createApp();
    for (let index = 0; index < 8; index++) {
      await request(app).post('/refresh').expect(204);
    }
    for (let index = 0; index < 7; index++) {
      await request(app).post('/login').expect(204);
    }
    await request(app).post('/login').expect(429);
    await request(app).post('/refresh').expect(204);
    expect(getAppConfig).toHaveBeenCalledTimes(1);
  });

  it('enforces the configured IP budget even when callers change the submitted user ID', async () => {
    const { app } = createApp({ windowMs: 60_000, max: 2 });
    await request(app).post('/refresh').send({ user_id: 'first' }).expect(204);
    await request(app).post('/refresh').send({ user_id: 'second' }).expect(204);
    const rejected = await request(app).post('/refresh').send({ user_id: 'third' }).expect(429);
    expect(rejected.body).toEqual({
      message: 'Too many session renewal requests. Try again later.',
    });
    await request(app).post('/login').expect(204);
  });

  it('logs a warning with the client address when it rejects a renewal', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { app } = createApp({ windowMs: 60_000, max: 1 });
    await request(app).post('/refresh').set('X-Forwarded-For', '198.51.100.24:50001').expect(204);
    expect(warn).not.toHaveBeenCalled();
    await request(app).post('/refresh').set('X-Forwarded-For', '198.51.100.24:50002').expect(429);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[adminRefreshLimiter] Admin token renewal rate limit exceeded',
      { ip: '198.51.100.24', windowMs: 60_000, max: 1 },
    );
    warn.mockRestore();
  });

  it('keeps one IPv4 budget when a trusted proxy forwards changing source ports', async () => {
    const { app } = createApp({ max: 2 });
    for (const port of [50001, 50002]) {
      await request(app)
        .post('/refresh')
        .set('X-Forwarded-For', `198.51.100.24:${port}`)
        .expect(204);
    }
    const rejected = await request(app)
      .post('/refresh')
      .set('X-Forwarded-For', '198.51.100.24:50003');
    expect(rejected.status).toBe(429);
    await request(app).post('/refresh').set('X-Forwarded-For', '198.51.100.25:50003').expect(204);
  });

  it('keeps IPv6 subnet grouping when a proxy adds brackets and a source port', async () => {
    const { app } = createApp({ max: 2 });
    for (const address of ['2001:db8:1234:5600::1', '[2001:db8:1234:56ff::2]:50002']) {
      await request(app).post('/refresh').set('X-Forwarded-For', address).expect(204);
    }
    const rejected = await request(app)
      .post('/refresh')
      .set('X-Forwarded-For', '2001:db8:1234:56aa::3');
    expect(rejected.status).toBe(429);
    await request(app).post('/refresh').set('X-Forwarded-For', '2001:db8:1234:5700::1').expect(204);
  });

  it('shares the IPv4 budget with mapped IPv6 addresses and source ports', async () => {
    const { app } = createApp({ max: 2 });
    for (const address of ['198.51.100.24', '::ffff:198.51.100.24']) {
      await request(app).post('/refresh').set('X-Forwarded-For', address).expect(204);
    }
    const rejected = await request(app)
      .post('/refresh')
      .set('X-Forwarded-For', '[::ffff:198.51.100.24]:50003');
    expect(rejected.status).toBe(429);
  });
});
