const mockRateLimit = jest.fn((options) => options);
const mockLimiterCache = jest.fn((name) => ({ name }));

jest.mock('express-rate-limit', () => mockRateLimit);
jest.mock('@librechat/api', () => ({
  limiterCache: mockLimiterCache,
  removePorts: (req) => req.ip,
  /** The key policy lives in packages/api and is covered by its own tests; here it records
   *  what this file feeds it, which is the wiring this file owns. */
  emailChangeSubmissionKey: (ip, submittedUserId) => `ip:${ip}:user:${String(submittedUserId)}`,
}));
jest.mock('~/cache', () => ({ logViolation: jest.fn() }));

const limiter = require('./emailChangeSubmissionLimiter');

describe('emailChangeSubmissionLimiter', () => {
  it('keys the allowance on the caller address and the submitted account', () => {
    expect(
      limiter.keyGenerator({ ip: '203.0.113.10', body: { userId: '507f1f77bcf86cd799439011' } }),
    ).toBe('ip:203.0.113.10:user:507f1f77bcf86cd799439011');
  });

  it('falls back to an unknown address when the request carries none', () => {
    expect(limiter.keyGenerator({ body: { userId: '507f1f77bcf86cd799439011' } })).toBe(
      'ip:unknown:user:507f1f77bcf86cd799439011',
    );
  });

  it('passes a missing body through to the policy rather than throwing', () => {
    expect(limiter.keyGenerator({ ip: '203.0.113.10' })).toBe('ip:203.0.113.10:user:undefined');
  });

  it('uses a store isolated from ordinary email verification', () => {
    expect(limiter.store).toEqual({ name: 'email_change_submission_limiter' });
  });
});
