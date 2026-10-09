import {
  exemptAgentTriggerFromIpLimiter,
  generateAgentTriggerToken,
  generateShortLivedToken,
  isAgentTriggerRequest,
} from './jwt';

describe('agent trigger IP limiter identity', () => {
  const original = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    if (original == null) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = original;
    }
  });

  it('exempts only a signed trigger from the shared loopback IP bucket', () => {
    const token = generateAgentTriggerToken('user-1');
    const req = {
      headers: {
        'x-lc-agent-trigger': '1',
        authorization: `Bearer ${token}`,
      },
    };

    expect(exemptAgentTriggerFromIpLimiter(req)).toBe(true);
    expect(exemptAgentTriggerFromIpLimiter({ headers: {} })).toBe(false);
    expect(
      exemptAgentTriggerFromIpLimiter({
        headers: {
          'x-lc-agent-trigger': '1',
          authorization: `Bearer ${generateShortLivedToken('user-1')}`,
        },
      }),
    ).toBe(false);
  });

  it('retains the router-captured decision after the short-lived token expires', () => {
    const req = { headers: { authorization: 'Bearer expired' }, _isAgentTrigger: true };

    expect(isAgentTriggerRequest(req)).toBe(false);
    expect(exemptAgentTriggerFromIpLimiter(req)).toBe(true);
  });
});
