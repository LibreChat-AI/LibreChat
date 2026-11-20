const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const { createTwoFactorLimiters, createTwoFactorTempUser } = jest.requireActual('@librechat/api');

const originalEnv = process.env;
const jwtSecret = 'test-two-factor-secret';

const createToken = (userId, purpose = 'login_2fa_challenge') =>
  jwt.sign({ userId, purpose }, jwtSecret, { expiresIn: '5m' });

const createApp = (max = '2', setupMax = '2') => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    JWT_SECRET: jwtSecret,
    LOGIN_MAX: '2',
    LOGIN_WINDOW: '5',
    TWO_FACTOR_TEMP_MAX: max,
    TWO_FACTOR_TEMP_WINDOW: '5',
    TWO_FACTOR_SETUP_MAX: setupMax,
    TWO_FACTOR_SETUP_WINDOW: '5',
  };

  jest.doMock('@librechat/api', () => ({
    createTwoFactorLimiters,
    createTwoFactorTempUser,
    limiterCache: jest.fn(() => undefined),
    removePorts: (req) => req?.['ip'],
  }));
  jest.doMock('~/cache', () => ({
    logViolation: jest.fn().mockResolvedValue(undefined),
  }));

  const setTwoFactorTempUser = require('../setTwoFactorTempUser');
  const { setTwoFactorAcknowledgementTempUser, setTwoFactorFinalizationTempUser } =
    setTwoFactorTempUser;
  const twoFactorTempLimiter = require('./twoFactorTempLimiter');
  const { twoFactorSetupLimiter } = twoFactorTempLimiter;
  const { logViolation } = require('~/cache');

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/verify', setTwoFactorTempUser, twoFactorTempLimiter, (req, res) =>
    res.status(204).end(),
  );
  app.post('/finalize', setTwoFactorFinalizationTempUser, twoFactorTempLimiter, (req, res) =>
    res.status(204).end(),
  );
  app.post('/acknowledge', setTwoFactorAcknowledgementTempUser, twoFactorTempLimiter, (req, res) =>
    res.status(204).end(),
  );
  /** Mirrors the production split: code checks on one quota, enrollment transitions on the other. */
  app.post('/setup', setTwoFactorTempUser, twoFactorSetupLimiter, (req, res) =>
    res.status(204).end(),
  );
  app.post(
    '/setup/acknowledge',
    setTwoFactorAcknowledgementTempUser,
    twoFactorSetupLimiter,
    (req, res) => res.status(204).end(),
  );
  app.post('/setup/confirm', setTwoFactorTempUser, twoFactorTempLimiter, (req, res) =>
    res.status(204).end(),
  );
  app.post('/setup/finalize', setTwoFactorFinalizationTempUser, twoFactorSetupLimiter, (req, res) =>
    res.status(204).end(),
  );

  return { app, logViolation };
};

describe('twoFactorTempLimiter', () => {
  afterEach(() => {
    jest.dontMock('@librechat/api');
    jest.dontMock('~/cache');
    process.env = originalEnv;
  });

  it('limits a valid temp-token user across rotating source IPs', async () => {
    const { app, logViolation } = createApp();
    const tempToken = createToken('user-1');

    await request(app)
      .post('/verify')
      .set('X-Forwarded-For', '203.0.113.1')
      .send({ tempToken, token: '000000' })
      .expect(204);
    await request(app)
      .post('/verify')
      .set('X-Forwarded-For', '203.0.113.2')
      .send({ tempToken, token: '000001' })
      .expect(204);

    const response = await request(app)
      .post('/verify')
      .set('X-Forwarded-For', '203.0.113.3')
      .send({ tempToken, token: '000002' })
      .expect(429);

    expect(response.body).toEqual({
      message: 'Too many verification attempts, please try again after 5 minutes.',
    });
    expect(logViolation).toHaveBeenCalledTimes(1);
    expect(logViolation.mock.calls[0][0].user).toEqual({ id: 'user-1' });
    expect(logViolation.mock.calls[0][3]).toMatchObject({
      limiter: 'user',
      max: '2',
      windowInMinutes: 5,
    });
  });

  it('keeps the source IP limit across valid challenge tokens for different users', async () => {
    const { app, logViolation } = createApp();

    await request(app)
      .post('/verify')
      .set('X-Forwarded-For', '198.51.100.1')
      .send({ tempToken: createToken('user-a'), token: '000000' })
      .expect(204);
    await request(app)
      .post('/verify')
      .set('X-Forwarded-For', '198.51.100.1')
      .send({ tempToken: createToken('user-b'), token: '000001' })
      .expect(204);

    await request(app)
      .post('/verify')
      .set('X-Forwarded-For', '198.51.100.1')
      .send({ tempToken: createToken('user-c'), token: '000002' })
      .expect(429);

    expect(logViolation).toHaveBeenCalledTimes(1);
    expect(logViolation.mock.calls[0][3]).toMatchObject({
      limiter: 'ip',
      max: '2',
      windowInMinutes: 5,
    });
  });

  it('does not charge enrollment transitions against the shared code-attempt IP quota', async () => {
    const { app, logViolation } = createApp('7', '20');
    const sourceIp = '198.51.100.10';

    for (const userId of ['user-a', 'user-b']) {
      const setupToken = createToken(userId, 'required_2fa_setup');
      const acknowledgementToken = createToken(userId, 'required_2fa_acknowledgement');
      const finalizationToken = createToken(userId, 'required_2fa_finalization');

      await request(app)
        .post('/setup')
        .set('X-Forwarded-For', sourceIp)
        .send({ tempToken: setupToken })
        .expect(204);
      await request(app)
        .post('/setup/confirm')
        .set('X-Forwarded-For', sourceIp)
        .send({ tempToken: setupToken, token: '000000' })
        .expect(204);
      await request(app)
        .post('/setup/acknowledge')
        .set('X-Forwarded-For', sourceIp)
        .send({ acknowledgementToken })
        .expect(204);
      await request(app)
        .post('/setup/finalize')
        .set('X-Forwarded-For', sourceIp)
        .send({ finalizationToken })
        .expect(204);
    }

    expect(logViolation).not.toHaveBeenCalled();
  });

  it.each([
    ['login challenge', 'tempToken', 'login_2fa_challenge', '/verify'],
    ['required setup', 'tempToken', 'required_2fa_setup', '/verify'],
    [
      'required acknowledgement',
      'acknowledgementToken',
      'required_2fa_acknowledgement',
      '/acknowledge',
    ],
    ['required finalization', 'finalizationToken', 'required_2fa_finalization', '/finalize'],
  ])('applies the same per-user limit to a %s token', async (_name, field, purpose, route) => {
    const { app, logViolation } = createApp();
    const token = createToken('user-shared', purpose);

    await request(app)
      .post(route)
      .set('X-Forwarded-For', '203.0.113.10')
      .send({ [field]: token })
      .expect(204);
    await request(app)
      .post(route)
      .set('X-Forwarded-For', '203.0.113.11')
      .send({ [field]: token })
      .expect(204);
    await request(app)
      .post(route)
      .set('X-Forwarded-For', '203.0.113.12')
      .send({ [field]: token })
      .expect(429);

    expect(logViolation.mock.calls[0][0].user).toEqual({ id: 'user-shared' });
  });

  it('binds finalization limiting to the finalization token when both fields are present', async () => {
    const { app, logViolation } = createApp();
    const finalizationToken = createToken('finalization-user', 'required_2fa_finalization');

    for (let attempt = 0; attempt < 2; attempt++) {
      await request(app)
        .post('/finalize')
        .set('X-Forwarded-For', `203.0.113.${20 + attempt}`)
        .send({
          tempToken: createToken(`decoy-${attempt}`),
          finalizationToken,
        })
        .expect(204);
    }

    await request(app)
      .post('/finalize')
      .set('X-Forwarded-For', '203.0.113.22')
      .send({ tempToken: createToken('decoy-2'), finalizationToken })
      .expect(429);

    expect(logViolation.mock.calls[0][0].user).toEqual({ id: 'finalization-user' });
  });

  /**
   * Sharing one quota let a handful of wrong codes strand a user who already held their backup
   * codes: confirmation succeeded, then finalization was refused and nothing was ever promoted.
   */
  it('keeps exhausted code attempts from blocking enrollment transitions', async () => {
    const { app, logViolation } = createApp();
    const tempToken = createToken('split-user', 'required_2fa_setup');
    const finalizationToken = createToken('split-user', 'required_2fa_finalization');

    await request(app)
      .post('/setup/confirm')
      .set('X-Forwarded-For', '203.0.113.40')
      .send({ tempToken, token: '000000' })
      .expect(204);
    await request(app)
      .post('/setup/confirm')
      .set('X-Forwarded-For', '203.0.113.41')
      .send({ tempToken, token: '000001' })
      .expect(204);
    await request(app)
      .post('/setup/confirm')
      .set('X-Forwarded-For', '203.0.113.42')
      .send({ tempToken, token: '000002' })
      .expect(429);

    const finalized = await request(app)
      .post('/setup/finalize')
      .set('X-Forwarded-For', '203.0.113.43')
      .send({ finalizationToken })
      .expect(204);

    expect(finalized.status).toBe(204);
    /** Only the exhausted code attempt was a violation; finalization drew on its own budget. */
    expect(logViolation).toHaveBeenCalledTimes(1);
    expect(logViolation.mock.calls[0][3]).toMatchObject({ limiter: 'user', max: '2' });
  });

  it.each([
    ['acknowledge', 'acknowledgementToken'],
    ['finalize', 'finalizationToken'],
  ])(
    'keeps invalid %s credentials in one bucket despite rotating decoys and IPs',
    async (route, field) => {
      const { app, logViolation } = createApp();
      for (let attempt = 0; attempt < 3; attempt++) {
        await request(app)
          .post(`/${route}`)
          .set('X-Forwarded-For', `203.0.113.${70 + attempt}`)
          .send({ tempToken: `decoy-${attempt}`, [field]: 'invalid-enrollment-token' })
          .expect(attempt < 2 ? 204 : 429);
      }
      expect(logViolation.mock.calls[0][3]).toMatchObject({ limiter: 'user' });
    },
  );

  it('still bounds the enrollment transition quota on its own budget', async () => {
    const { app, logViolation } = createApp('7', '2');
    const finalizationToken = createToken('transition-user', 'required_2fa_finalization');

    for (let attempt = 0; attempt < 2; attempt++) {
      await request(app)
        .post('/setup/finalize')
        .set('X-Forwarded-For', `203.0.113.${50 + attempt}`)
        .send({ finalizationToken })
        .expect(204);
    }

    const response = await request(app)
      .post('/setup/finalize')
      .set('X-Forwarded-For', '203.0.113.52')
      .send({ finalizationToken })
      .expect(429);

    expect(response.body).toEqual({
      message: 'Too many two-factor setup requests, please try again after 5 minutes.',
    });
    expect(logViolation.mock.calls[0][0].user).toEqual({ id: 'transition-user' });
  });

  it('binds acknowledgement limiting to the acknowledgement token when a decoy setup token is present', async () => {
    const { app, logViolation } = createApp();
    const acknowledgementToken = createToken(
      'acknowledgement-user',
      'required_2fa_acknowledgement',
    );

    for (let attempt = 0; attempt < 2; attempt++) {
      await request(app)
        .post('/acknowledge')
        .set('X-Forwarded-For', `203.0.113.${30 + attempt}`)
        .send({ tempToken: createToken(`decoy-${attempt}`), acknowledgementToken })
        .expect(204);
    }

    await request(app)
      .post('/acknowledge')
      .set('X-Forwarded-For', '203.0.113.32')
      .send({ tempToken: createToken('decoy-2'), acknowledgementToken })
      .expect(429);

    expect(logViolation.mock.calls[0][0].user).toEqual({ id: 'acknowledgement-user' });
  });
});
