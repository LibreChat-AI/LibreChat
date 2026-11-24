const mockLimiter = jest.fn((_req, _res, next) => next());
const mockRateLimit = jest.fn(() => mockLimiter);
const mockEventLimiter = jest.fn((_req, _res, next) => next());

jest.mock('express-rate-limit', () => mockRateLimit);
jest.mock('@librechat/api', () => ({
  limiterCache: jest.fn((prefix) => ({ prefix })),
  removePorts: jest.fn(),
  createAgentEventLimiter: jest.fn(() => mockEventLimiter),
  getRateLimitReset: jest.requireActual('../../../../packages/api/src/utils/limiter.ts')
    .getRateLimitReset,
}));
jest.mock('~/server/middleware/denyRequest', () => jest.fn());
jest.mock('~/cache', () => ({ logViolation: jest.fn() }));

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

  /** express-rate-limit rejects a limiter created while a request is being handled. */
  it('is built when the module loads, from the YAML-projected limits', () => {
    process.env.AGENT_EVENT_USER_MAX = '80';
    process.env.AGENT_EVENT_USER_WINDOW = '2';
    const { agentEventUserLimiter } = require('./messageLimiters');
    const { createAgentEventLimiter } = require('@librechat/api');

    expect(createAgentEventLimiter).toHaveBeenCalledTimes(1);
    expect(createAgentEventLimiter).toHaveBeenCalledWith({
      max: '80',
      window: '2',
      store: { prefix: 'agent_event_user_limiter' },
    });
    expect(agentEventUserLimiter).toBe(mockEventLimiter);
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
    const userOptions = mockRateLimit.mock.calls.at(-1)[0];
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
    const ipOptions = mockRateLimit.mock.calls.at(-2)[0];

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
