import express from 'express';
import request from 'supertest';
import type { RequestHandler } from 'express';
import type * as CodeMiddleware from './code';

jest.mock('~/cache/cacheFactory', () => ({ limiterCache: () => undefined }));

function createApp(limiter: RequestHandler) {
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: req.get('x-test-user') } });
    next();
  });
  app.get('/', limiter, (_req, res) => {
    res.sendStatus(200);
  });
  return app;
}

describe('code environment limiters', () => {
  let codeEnvironmentPairingLimiter: RequestHandler;
  let codeEnvironmentStatusIpLimiter: RequestHandler;
  let codeEnvironmentStatusLimiter: RequestHandler;

  beforeEach(() => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      CODE_ENVIRONMENT_PAIRING_USER_MAX: '2',
      CODE_ENVIRONMENT_PAIRING_USER_WINDOW: '2',
      CODE_ENVIRONMENT_STATUS_USER_MAX: '2',
      CODE_ENVIRONMENT_STATUS_IP_MAX: '2',
    });
    jest.isolateModules(() => {
      ({
        codeEnvironmentPairingLimiter,
        codeEnvironmentStatusIpLimiter,
        codeEnvironmentStatusLimiter,
      } = jest.requireActual<typeof CodeMiddleware>('./code'));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('limits pairing per user and returns a bounded retry delay', async () => {
    const app = createApp(codeEnvironmentPairingLimiter);
    await request(app).get('/').set('x-test-user', 'pairing-user').expect(200);
    await request(app).get('/').set('x-test-user', 'pairing-user').expect(200);

    const limited = await request(app).get('/').set('x-test-user', 'pairing-user').expect(429);
    expect(limited.body.error.code).toBe('code_environment_pairing_rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(120);
    await request(app).get('/').set('x-test-user', 'other-pairing-user').expect(200);
  });

  test('keeps the user status bucket across IP changes without limiting other users', async () => {
    const app = createApp(codeEnvironmentStatusLimiter);
    await request(app)
      .get('/')
      .set('x-test-user', 'status-user')
      .set('X-Forwarded-For', '192.0.2.1')
      .expect(200);
    await request(app)
      .get('/')
      .set('x-test-user', 'status-user')
      .set('X-Forwarded-For', '192.0.2.2')
      .expect(200);
    const limited = await request(app)
      .get('/')
      .set('x-test-user', 'status-user')
      .set('X-Forwarded-For', '192.0.2.3')
      .expect(429);
    expect(limited.body.error.code).toBe('code_environment_status_rate_limited');
    await request(app)
      .get('/')
      .set('x-test-user', 'other-status-user')
      .set('X-Forwarded-For', '192.0.2.1')
      .expect(200);
  });

  test('shares the IP status bucket across users and normalized IPv6 addresses', async () => {
    const app = createApp(codeEnvironmentStatusIpLimiter);
    await request(app)
      .get('/')
      .set('x-test-user', 'ip-user-1')
      .set('X-Forwarded-For', '2001:db8:1::1')
      .expect(200);
    await request(app)
      .get('/')
      .set('x-test-user', 'ip-user-2')
      .set('X-Forwarded-For', '2001:db8:1::2')
      .expect(200);
    const limited = await request(app)
      .get('/')
      .set('x-test-user', 'ip-user-3')
      .set('X-Forwarded-For', '2001:db8:1::3')
      .expect(429);
    expect(limited.body.error.code).toBe('code_environment_status_rate_limited');
    await request(app)
      .get('/')
      .set('x-test-user', 'ip-user-1')
      .set('X-Forwarded-For', '2001:db8:2::1')
      .expect(200);
  });
});
