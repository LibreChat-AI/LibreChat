const express = require('express');
const request = require('supertest');

const mockLimiter = jest.fn((_req, _res, next) => next());
const mockRateLimit = jest.fn(() => mockLimiter);

jest.mock('express-rate-limit', () => mockRateLimit);
jest.mock('@librechat/api', () => ({
  limiterCache: jest.fn((prefix) => ({ prefix })),
  removePorts: jest.fn(),
  getRateLimitReset: jest.requireActual('../../../../packages/api/src/utils/limiter.ts')
    .getRateLimitReset,
}));
jest.mock('~/server/middleware/denyRequest', () => jest.fn());
jest.mock('~/cache', () => ({ logViolation: jest.fn() }));

/** The options a limiter was built with, found by its store so creation order is free to change. */
const optionsFor = (prefix) =>
  mockRateLimit.mock.calls.map(([options]) => options).find((o) => o.store?.prefix === prefix);

describe('agent event rate limiter', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  it('reads YAML-projected limits when the module loads', () => {
    process.env.AGENT_EVENT_USER_MAX = '80';
    process.env.AGENT_EVENT_USER_WINDOW = '2';
    const { agentEventUserLimiter } = require('./messageLimiters');

    expect(optionsFor('agent_event_user_limiter')).toEqual(
      expect.objectContaining({ max: 80, windowMs: 120_000 }),
    );
    expect(agentEventUserLimiter).toBe(mockLimiter);
  });

  it('keys the bucket by API key, falling back to the user', () => {
    require('./messageLimiters');
    const { keyGenerator } = optionsFor('agent_event_user_limiter');

    expect(keyGenerator({ apiKeyId: 'key-1', user: { id: 'user-1' } })).toBe('key-1');
    expect(keyGenerator({ user: { id: 'user-1' } })).toBe('user-1');
  });

  it('returns an actionable JSON 429 without recording a message violation', async () => {
    process.env.AGENT_EVENT_USER_MAX = '80';
    process.env.AGENT_EVENT_USER_WINDOW = '2';
    require('./messageLimiters');
    const { logViolation } = require('~/cache');
    const denyRequest = require('~/server/middleware/denyRequest');
    const options = optionsFor('agent_event_user_limiter');
    const app = express();
    app.use((req, _res, next) => {
      req.rateLimit = { resetTime: new Date(Date.now() + 30_000) };
      next();
    });
    app.post('/api/agents/v1/events', options.handler);
    const response = await request(app).post('/api/agents/v1/events');

    expect(response.status).toBe(429);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.body).toEqual({
      error: {
        code: 'agent_event_rate_limited',
        message: 'Agent event admission rate limit exceeded.',
        type: 'rate_limit_error',
      },
    });
    expect(response.text).not.toContain('event:');
    expect(logViolation).not.toHaveBeenCalled();
    expect(denyRequest).not.toHaveBeenCalled();
  });
});

describe('agent event rate limiter creation', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
    jest.doMock('express-rate-limit', () => jest.requireActual('express-rate-limit'));
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.doMock('express-rate-limit', () => mockRateLimit);
    console.error.mockRestore?.();
  });

  /** express-rate-limit reports a limiter built while a request is being handled. */
  it('is built before the first request reaches it', async () => {
    process.env.AGENT_EVENT_USER_MAX = '1';
    require('@librechat/api').limiterCache.mockReturnValue(undefined);
    const report = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { agentEventUserLimiter } = require('./messageLimiters');
    const app = express();
    app.use((req, _res, next) => {
      req.apiKeyId = 'key-1';
      next();
    });
    app.post('/api/agents/v1/events', agentEventUserLimiter, (_req, res) => res.sendStatus(202));

    const admitted = await request(app).post('/api/agents/v1/events');
    const limited = await request(app).post('/api/agents/v1/events');

    expect(report.mock.calls.map(([error]) => error?.code)).not.toContain(
      'ERR_ERL_CREATED_IN_REQUEST_HANDLER',
    );
    expect(admitted.status).toBe(202);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body.error.code).toBe('agent_event_rate_limited');
  });
});

describe('message rate limiter violation payload', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  /** The chat client counts down to this timestamp, so the persisted payload has to carry it. */
  it('persists the window reset alongside the limit it hit', async () => {
    jest.useFakeTimers({ now: Date.UTC(2026, 8, 13, 12, 0, 0) });
    process.env.MESSAGE_USER_MAX = '40';
    process.env.MESSAGE_USER_WINDOW = '60';
    require('./messageLimiters');
    const { logViolation } = require('~/cache');
    const denyRequest = require('~/server/middleware/denyRequest');
    const userOptions = optionsFor('message_user_limiter');
    const resetTime = new Date(Date.now() + 7 * 60 * 1000);
    const expected = expect.objectContaining({
      type: 'message_limit',
      limiter: 'user',
      windowInMinutes: 60,
      resetAt: resetTime.getTime(),
      retryAfterSeconds: 420,
    });

    await userOptions.handler({ rateLimit: { resetTime }, user: { id: 'user-1' } }, {});

    expect(logViolation.mock.calls.at(-1)[3]).toEqual(expected);
    expect(denyRequest.mock.calls.at(-1)[2]).toEqual(expected);
  });

  /** Without a populated `rateLimit`, the payload still has to name a reachable retry moment. */
  it('falls back to the configured window when the limiter reports no reset time', async () => {
    const now = Date.UTC(2026, 8, 13, 12, 0, 0);
    jest.useFakeTimers({ now });
    process.env.MESSAGE_IP_WINDOW = '1';
    require('./messageLimiters');
    const denyRequest = require('~/server/middleware/denyRequest');
    const ipOptions = optionsFor('message_ip_limiter');

    await ipOptions.handler({}, {});

    expect(denyRequest.mock.calls.at(-1)[2]).toEqual(
      expect.objectContaining({
        limiter: 'ip',
        windowInMinutes: 1,
        resetAt: now + 60 * 1000,
        retryAfterSeconds: 60,
      }),
    );
  });
});
