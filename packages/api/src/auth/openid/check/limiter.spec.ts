import express from 'express';
import request from 'supertest';
import session from 'express-session';
import { createOpenIDCheckLimiter } from './limiter';

it('shares a configurable check budget while other browser sessions and login stay usable', async () => {
  const app = express();
  app.use(session({ secret: 'local-test-secret', resave: false, saveUninitialized: false }));
  app.post('/login', (req, res) => {
    Object.assign(req.session, { openidTokens: { authGenerationId: 'test' } });
    res.sendStatus(204);
  });
  const limiter = createOpenIDCheckLimiter({
    getConfig: async () => ({
      config: { rateLimits: { openidSessionCheck: { requestsPerFiveMinutes: 3 } } },
    }),
    removePorts: (req) => req.ip,
    clientDomain: 'https://app.test',
  });
  app.post('/check', limiter, (_req, res) => {
    res.json({ status: 'verified' });
  });
  app.get('/callback', limiter, (_req, res) => {
    res.sendStatus(204);
  });
  const first = request.agent(app).set('Connection', 'close');
  const second = request.agent(app).set('Connection', 'close');
  await first.post('/login');
  await second.post('/login');
  for (let i = 0; i < 3; i++) await first.post('/check').expect(200);
  const blocked = await first.post('/check').expect(429);
  expect(blocked.body).toEqual({ status: 'unavailable' });
  const callback = await first.get('/callback').expect(302);
  expect(callback.headers.location).toBe('https://app.test/?openid_check=invalid');
  await second.post('/check').expect(200);
  await first.post('/login').expect(204);
});
