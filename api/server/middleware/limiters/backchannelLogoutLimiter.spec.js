const express = require('express');
const request = require('supertest');

const createApp = (getBackchannelLogoutConfig) => {
  jest.resetModules();

  jest.doMock('@librechat/api', () => ({
    ...jest.requireActual('@librechat/api'),
    limiterCache: jest.fn(() => undefined),
    removePorts: (req) => req?.['ip'],
  }));
  jest.doMock('~/server/services/ProviderSession', () => ({
    getBackchannelLogoutConfig,
  }));

  const backchannelLogoutLimiter = require('./backchannelLogoutLimiter');

  const app = express();
  app.use(backchannelLogoutLimiter, (_req, res) => res.status(204).end());
  app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));

  return app;
};

describe('backchannelLogoutLimiter', () => {
  afterEach(() => {
    jest.dontMock('@librechat/api');
    jest.dontMock('~/server/services/ProviderSession');
  });

  it('retries the config load on the next request instead of caching the rejection', async () => {
    const getBackchannelLogoutConfig = jest
      .fn()
      .mockRejectedValueOnce(new Error('config unavailable'))
      .mockResolvedValueOnce({ rateLimit: { windowMs: 60000, max: 10 } });
    const app = createApp(getBackchannelLogoutConfig);

    await request(app).post('/').expect(500);
    await request(app).post('/').expect(204);

    expect(getBackchannelLogoutConfig).toHaveBeenCalledTimes(2);
  });

  it('builds the limiter once a config load succeeds and reuses it for later requests', async () => {
    const getBackchannelLogoutConfig = jest
      .fn()
      .mockResolvedValue({ rateLimit: { windowMs: 60000, max: 10 } });
    const app = createApp(getBackchannelLogoutConfig);

    await request(app).post('/').expect(204);
    await request(app).post('/').expect(204);

    expect(getBackchannelLogoutConfig).toHaveBeenCalledTimes(1);
  });
});
