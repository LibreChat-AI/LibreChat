import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';
import { createPromptResolveLimiter, windowMsFromMinutes } from './promptResolveLimiter';

jest.mock('~/cache/cacheFactory', () => ({ limiterCache: () => undefined }));

function createApp(limiter: RequestHandler) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: req.get('x-test-user') } });
    next();
  });
  app.get('/', limiter, (_req, res) => {
    res.sendStatus(200);
  });
  return app;
}

describe('createPromptResolveLimiter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PROMPT_RESOLVE_USER_MAX;
    delete process.env.PROMPT_RESOLVE_USER_WINDOW;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults to 60 requests per minute per user', async () => {
    const app = createApp(createPromptResolveLimiter());
    const response = await request(app).get('/').set('x-test-user', 'default-user').expect(200);
    expect(response.headers['x-ratelimit-limit']).toBe('60');
  });

  it('applies a configured override and keeps the original 429 body', async () => {
    process.env.PROMPT_RESOLVE_USER_MAX = '2';
    process.env.PROMPT_RESOLVE_USER_WINDOW = '2';
    const app = createApp(createPromptResolveLimiter());
    await request(app).get('/').set('x-test-user', 'override-user').expect(200);
    await request(app).get('/').set('x-test-user', 'override-user').expect(200);
    const blocked = await request(app).get('/').set('x-test-user', 'override-user').expect(429);
    expect(blocked.body).toEqual({
      message: 'Too many prompt resolve requests. Try again later',
    });
  });

  it('keys the limit per user', async () => {
    process.env.PROMPT_RESOLVE_USER_MAX = '1';
    const app = createApp(createPromptResolveLimiter());
    await request(app).get('/').set('x-test-user', 'user-a').expect(200);
    await request(app).get('/').set('x-test-user', 'user-a').expect(429);
    const otherUser = await request(app).get('/').set('x-test-user', 'user-b').expect(200);
    expect(otherUser.status).toBe(200);
  });
});

describe('windowMsFromMinutes', () => {
  it('converts a fractional window in minutes to milliseconds, instead of falling back to 1 minute', () => {
    expect(windowMsFromMinutes('0.5', 1)).toBe(30_000);
  });

  it('converts a whole number of minutes to milliseconds', () => {
    expect(windowMsFromMinutes('2', 1)).toBe(120_000);
  });

  it('falls back to the given minutes for a missing, zero, or negative value', () => {
    expect(windowMsFromMinutes(undefined, 1)).toBe(60_000);
    expect(windowMsFromMinutes('0', 1)).toBe(60_000);
    expect(windowMsFromMinutes('-5', 1)).toBe(60_000);
  });
});
