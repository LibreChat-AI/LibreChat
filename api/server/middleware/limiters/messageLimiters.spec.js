const express = require('express');
const request = require('supertest');

const mockLimiter = jest.fn((_req, _res, next) => next());
const mockRateLimit = jest.fn(() => mockLimiter);

jest.mock('express-rate-limit', () => mockRateLimit);
jest.mock('@librechat/api', () => ({
  limiterCache: jest.fn(() => ({})),
  removePorts: jest.fn(),
  getRateLimitReset: jest.requireActual('../../../../packages/api/src/utils/limiter.ts')
    .getRateLimitReset,
}));
jest.mock('~/server/middleware/denyRequest', () => jest.fn());
jest.mock('~/cache', () => ({ logViolation: jest.fn() }));

/** A limiter's options, found by its store name rather than creation order. */
function limiterOptions(storeName) {
  const { limiterCache } = require('@librechat/api');
  const index = limiterCache.mock.calls.findIndex(([name]) => name === storeName);
  const store = limiterCache.mock.results[index].value;
  return mockRateLimit.mock.calls.find(([options]) => options.store === store)[0];
}

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

  it('reads YAML-projected limits lazily after startup configuration', () => {
    process.env.AGENT_EVENT_USER_MAX = '80';
    process.env.AGENT_EVENT_USER_WINDOW = '2';
    const { agentEventUserLimiter } = require('./messageLimiters');
    const { limiterCache } = require('@librechat/api');
    const next = jest.fn();

    agentEventUserLimiter({ apiKeyId: 'key-1' }, {}, next);

    expect(mockRateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ max: 80, windowMs: 120_000 }),
    );
    expect(limiterCache).toHaveBeenCalledWith('agent_event_user_limiter');
    expect(mockLimiter).toHaveBeenCalledWith({ apiKeyId: 'key-1' }, {}, next);
  });

  it('returns an actionable JSON 429 without recording a message violation', async () => {
    process.env.AGENT_EVENT_USER_MAX = '80';
    process.env.AGENT_EVENT_USER_WINDOW = '2';
    const { agentEventUserLimiter } = require('./messageLimiters');
    const { logViolation } = require('~/cache');
    const denyRequest = require('~/server/middleware/denyRequest');

    agentEventUserLimiter({ apiKeyId: 'key-1' }, {}, jest.fn());
    const options = mockRateLimit.mock.calls.at(-1)[0];
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
    const userOptions = limiterOptions('message_user_limiter');
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
    const ipOptions = limiterOptions('message_ip_limiter');

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

describe('OpenAI-compatible API message limiters', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRateLimit.mockClear();
  });

  function apiHandler(storeName) {
    require('./messageLimiters');
    const { limiterCache } = require('@librechat/api');
    const index = limiterCache.mock.calls.findIndex(([name]) => name === storeName);
    expect(index).toBeGreaterThanOrEqual(0);
    return mockRateLimit.mock.calls.find(
      ([options]) => options.store === limiterCache.mock.results[index].value,
    )[0];
  }

  it.each([
    ['message_ip_api_limiter', 'ip'],
    ['message_user_api_limiter', 'user'],
  ])(
    'answers %s as a JSON 429, logs the violation, and saves no chat message',
    async (store, limiter) => {
      const options = apiHandler(store);
      const { logViolation } = require('~/cache');
      const denyRequest = require('~/server/middleware/denyRequest');
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.user = { id: 'user-1' };
        req.rateLimit = { resetTime: new Date(Date.now() + 30_000) };
        next();
      });
      app.post('/api/agents/v1/chat/completions', options.handler);

      const response = await request(app).post('/api/agents/v1/chat/completions').send({
        model: 'gpt-concise',
        messageId: 'owned',
        conversationId: 'c',
        parentMessageId: 'p',
      });

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBeDefined();
      expect(response.body.error).toMatchObject({
        code: 'rate_limit_exceeded',
        type: 'rate_limit_error',
      });
      expect(logViolation).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'message_limit',
        expect.objectContaining({ limiter }),
        undefined,
      );
      expect(denyRequest).not.toHaveBeenCalled();
    },
  );
});
