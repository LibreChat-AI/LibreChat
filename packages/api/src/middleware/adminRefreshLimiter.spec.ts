import express from 'express';
import request from 'supertest';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '@librechat/data-schemas';
import { createAdminRefreshLimiter } from './adminRefreshLimiter';

function createApp(config = {}) {
  const app = express();
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
});
