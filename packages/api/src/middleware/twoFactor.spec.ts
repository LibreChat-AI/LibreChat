import express from 'express';
import request from 'supertest';
import type { AppConfig } from '@librechat/data-schemas';
import { createTwoFactorManagementLimiter } from './twoFactor';

describe('createTwoFactorManagementLimiter', () => {
  afterEach(() => jest.useRealTimers());

  function createApp(max = 2) {
    const getAppConfig = jest.fn(
      async () =>
        ({
          config: { rateLimits: { twoFactorManagement: { requestsPerFiveMinutes: max } } },
        }) as AppConfig,
    );
    const app = express();
    app.use((req, _res, next) => {
      if (req.headers['x-user']) {
        Object.assign(req, { user: { _id: req.get('x-user') } });
      }
      next();
    });
    app.use(createTwoFactorManagementLimiter({ getAppConfig }));
    app.post('/', (_req, res) => {
      res.sendStatus(400);
    });
    return { app, getAppConfig };
  }

  it('counts failed verification and respects configured budgets and Mongo-style identity', async () => {
    const { app } = createApp();
    await request(app).post('/').set('x-user', 'account').expect(400);
    await request(app).post('/').set('x-user', 'account').expect(400);
    const blocked = await request(app).post('/').set('x-user', 'account').expect(429);
    expect(blocked.body).toEqual({
      code: 'TWO_FACTOR_RATE_LIMITED',
      message: 'Too many verification attempts. Try again later.',
    });
  });

  it('rejects missing identity without consulting configuration', async () => {
    const { app, getAppConfig } = createApp();
    await request(app).post('/').expect(401);
    expect(getAppConfig).not.toHaveBeenCalled();
  });

  it('restores the budget after five minutes', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { app } = createApp(1);
    await request(app).post('/').set('x-user', 'account').expect(400);
    await request(app).post('/').set('x-user', 'account').expect(429);
    jest.advanceTimersByTime(5 * 60 * 1000);
    const restored = await request(app).post('/').set('x-user', 'account').expect(400);
    expect(restored.headers['ratelimit-remaining']).toBe('0');
  });

  it('does not admit verification when configuration loading fails', async () => {
    const { app, getAppConfig } = createApp();
    getAppConfig.mockRejectedValueOnce(new Error('unavailable'));
    await request(app).post('/').set('x-user', 'account').expect(500);
    expect(getAppConfig).toHaveBeenCalledTimes(1);
  });
});
