const express = require('express');
const request = require('supertest');

const mockLogViolation = jest.fn();

jest.mock('@librechat/api', () => ({
  limiterCache: jest.fn(() => undefined),
  removePorts: (req) => req.ip,
}));
jest.mock(
  '~/cache/logViolation',
  () =>
    (...args) =>
      mockLogViolation(...args),
);

describe('shared link limiters', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const buildApp = (user, { trustProxy = false } = {}) => {
    const { createShareLimiters } = require('./shareLimiters');
    const { shareIpLimiter, shareUserLimiter } = createShareLimiters();
    const app = express();
    if (trustProxy) {
      app.set('trust proxy', true);
    }
    app.get(
      '/api/share/:shareId',
      (req, _res, next) => {
        req.user = user;
        next();
      },
      shareIpLimiter,
      shareUserLimiter,
      (_req, res) => res.status(200).json({ ok: true }),
    );
    return app;
  };

  it('rejects an anonymous retrieval flood by IP', async () => {
    process.env.SHARE_IP_MAX = '2';
    process.env.SHARE_IP_WINDOW = '1';
    const app = buildApp(undefined);

    await request(app).get('/api/share/share-1').expect(200);
    await request(app).get('/api/share/share-1').expect(200);
    const response = await request(app).get('/api/share/share-1').expect(429);

    expect(response.body).toEqual({ message: 'Too many shared link requests. Try again later' });
    expect(mockLogViolation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'share_limit',
      expect.objectContaining({ limiter: 'ip', max: 2, windowInMinutes: 1 }),
      0,
    );
  });

  it('keeps an unset violation score from banning shared link viewers', async () => {
    process.env.SHARE_IP_MAX = '1';
    delete process.env.SHARE_VIOLATION_SCORE;
    const app = buildApp({ id: 'user-1' });

    await request(app).get('/api/share/share-1').expect(200);
    await request(app).get('/api/share/share-1').expect(429);

    expect(mockLogViolation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'share_limit',
      expect.anything(),
      0,
    );
  });

  it('buckets IPv6 viewers by subnet so address rotation cannot mint a bucket', async () => {
    process.env.SHARE_IP_MAX = '1';
    const app = buildApp(undefined, { trustProxy: true });

    const retrieve = (address) =>
      request(app).get('/api/share/share-1').set('X-Forwarded-For', address);

    expect((await retrieve('2001:db8:1234:5600::1')).status).toBe(200);
    expect((await retrieve('2001:db8:1234:5622::9')).status).toBe(429);
    expect((await retrieve('2001:db8:1234:5700::1')).status).toBe(200);
  });

  it('rejects an authenticated retrieval flood by user', async () => {
    process.env.SHARE_IP_MAX = '100';
    process.env.SHARE_USER_MAX = '1';
    process.env.SHARE_USER_WINDOW = '1';
    process.env.SHARE_VIOLATION_SCORE = '3';
    const app = buildApp({ id: 'user-1' });

    await request(app).get('/api/share/share-1').expect(200);
    await request(app).get('/api/share/share-1').expect(429);

    expect(mockLogViolation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'share_limit',
      expect.objectContaining({ limiter: 'user', max: 1 }),
      '3',
    );
  });

  it('leaves the per-user bucket untouched for anonymous viewers', async () => {
    process.env.SHARE_IP_MAX = '100';
    process.env.SHARE_USER_MAX = '1';
    const app = buildApp(undefined);

    await request(app).get('/api/share/share-1').expect(200);
    await request(app).get('/api/share/share-1').expect(200);

    expect(mockLogViolation).not.toHaveBeenCalled();
  });
});
