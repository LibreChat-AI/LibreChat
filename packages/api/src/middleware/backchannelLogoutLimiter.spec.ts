import express from 'express';
import request from 'supertest';
import type { CreateBackchannelLogoutLimiterDeps } from './backchannelLogoutLimiter';
import { createBackchannelLogoutLimiter } from './backchannelLogoutLimiter';

function createApp(deps: CreateBackchannelLogoutLimiterDeps) {
  const app = express();
  app.post('/', createBackchannelLogoutLimiter(deps), (_req, res) => {
    res.status(204).end();
  });
  const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(500).json({ message: (err as Error).message });
  };
  app.use(errorHandler);
  return app;
}

describe('createBackchannelLogoutLimiter', () => {
  const removePorts = (req: express.Request) => req.ip;
  const limiterCache = jest.fn(() => undefined);

  it('retries the config load on the next request instead of caching the rejection', async () => {
    const getConfig = jest
      .fn()
      .mockRejectedValueOnce(new Error('config unavailable'))
      .mockResolvedValueOnce({ rateLimit: { windowMs: 60000, max: 10 } });
    const app = createApp({ getConfig, removePorts, limiterCache });

    await request(app).post('/').expect(500);
    await request(app).post('/').expect(204);

    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('builds the limiter once a config load succeeds and reuses it for later requests', async () => {
    const getConfig = jest.fn().mockResolvedValue({ rateLimit: { windowMs: 60000, max: 10 } });
    const app = createApp({ getConfig, removePorts, limiterCache });

    await request(app).post('/').expect(204);
    await request(app).post('/').expect(204);

    expect(getConfig).toHaveBeenCalledTimes(1);
  });
});
