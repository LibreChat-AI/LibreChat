const express = require('express');
const request = require('supertest');

const originalEnv = process.env;

const createApp = () => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    PASSKEY_STEPUP_MAX: '2',
    PASSKEY_STEPUP_WINDOW: '15',
  };

  jest.doMock('@librechat/api', () => ({
    limiterCache: jest.fn(() => undefined),
    removePorts: (req) => req?.['ip'],
  }));
  jest.doMock('~/cache', () => ({
    logViolation: jest.fn().mockResolvedValue(undefined),
  }));

  const passkeyStepUpLimiter = require('./passkeyStepUpLimiter');
  const { logViolation } = require('~/cache');

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post(
    '/passkey/register/options',
    (req, res, next) => {
      req.user = { id: req.get('X-Test-User') };
      next();
    },
    passkeyStepUpLimiter,
    (req, res) => res.status(204).end(),
  );

  return { app, logViolation };
};

const post = (app, userId, ip) =>
  request(app)
    .post('/passkey/register/options')
    .set('X-Test-User', userId)
    .set('X-Forwarded-For', ip)
    .send({ password: 'secret' });

describe('passkeyStepUpLimiter', () => {
  afterEach(() => {
    jest.dontMock('@librechat/api');
    jest.dontMock('~/cache');
    process.env = originalEnv;
  });

  it('limits one user across rotating source IPs', async () => {
    const { app } = createApp();

    await post(app, 'user-1', '203.0.113.1').expect(204);
    await post(app, 'user-1', '203.0.113.2').expect(204);

    const response = await post(app, 'user-1', '203.0.113.3').expect(429);

    expect(response.body).toEqual({
      message: 'Too many passkey confirmation attempts, please try again after 15 minutes.',
    });
  });

  it('keys by user id, so a shared source IP does not exhaust another account', async () => {
    const { app } = createApp();

    await post(app, 'user-a', '198.51.100.1').expect(204);
    await post(app, 'user-a', '198.51.100.1').expect(204);
    const exhausted = await post(app, 'user-a', '198.51.100.1');

    const first = await post(app, 'user-b', '198.51.100.1');
    const second = await post(app, 'user-b', '198.51.100.1');

    expect(exhausted.status).toBe(429);
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('does not feed enrollment attempts into the login ban system', async () => {
    const { app, logViolation } = createApp();

    await post(app, 'user-1', '203.0.113.1').expect(204);
    await post(app, 'user-1', '203.0.113.1').expect(204);
    await post(app, 'user-1', '203.0.113.1').expect(429);

    expect(logViolation).not.toHaveBeenCalled();
  });
});
