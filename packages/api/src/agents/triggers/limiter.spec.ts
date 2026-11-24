import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { createAgentEventLimiter } from './limiter';

type Principal = { apiKeyId?: string; user?: { id?: string } };

function createApp(limiter: RequestHandler) {
  const app = express();
  app.use((req, _res, next) => {
    const principal: Principal = { user: { id: req.get('x-test-user') } };
    const apiKeyId = req.get('x-test-key');
    if (apiKeyId) {
      principal.apiKeyId = apiKeyId;
    }
    Object.assign(req, principal);
    next();
  });
  app.post('/events', limiter, (_req, res) => {
    res.sendStatus(202);
  });
  return app;
}

describe('createAgentEventLimiter', () => {
  it('defaults to 40 admissions per minute', async () => {
    const app = createApp(createAgentEventLimiter());

    const response = await request(app).post('/events').set('x-test-key', 'key-1').expect(202);

    expect(response.headers['x-ratelimit-limit']).toBe('40');
  });

  it('answers over budget with a JSON 429 and a Retry-After for the configured window', async () => {
    const app = createApp(createAgentEventLimiter({ max: '1', window: '2' }));
    await request(app).post('/events').set('x-test-key', 'key-1').expect(202);

    const limited = await request(app).post('/events').set('x-test-key', 'key-1').expect(429);

    expect(limited.headers['content-type']).toMatch(/^application\/json/);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(60);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(120);
    expect(limited.body).toEqual({
      error: {
        code: 'agent_event_rate_limited',
        message: 'Agent event admission rate limit exceeded.',
        type: 'rate_limit_error',
      },
    });
  });

  it('keys the bucket by API key, falling back to the user', async () => {
    const app = createApp(createAgentEventLimiter({ max: '1' }));
    const send = async (user: string, key?: string) => {
      const pending = request(app).post('/events').set('x-test-user', user);
      return (await (key ? pending.set('x-test-key', key) : pending)).status;
    };

    const statuses = [
      await send('user-1', 'key-1'),
      await send('user-1', 'key-2'),
      await send('user-1'),
      await send('user-1'),
      await send('user-2', 'key-1'),
    ];

    expect(statuses).toEqual([202, 202, 202, 429, 429]);
  });
});
