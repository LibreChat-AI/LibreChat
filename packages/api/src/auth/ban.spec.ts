import { ViolationTypes } from 'librechat-data-provider';
import { runBanUserCommand } from './ban';

function dependencies() {
  return {
    args: ['user@example.com', '120000'],
    askQuestion: jest.fn<Promise<string>, [string]>(),
    findUserByEmail: jest.fn(async () => ({
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      email: 'user@example.com',
    })),
    banViolation: jest
      .fn<
        ReturnType<Parameters<typeof runBanUserCommand>[0]['banViolation']>,
        Parameters<Parameters<typeof runBanUserCommand>[0]['banViolation']>
      >()
      .mockResolvedValue(undefined),
    purple: jest.fn(),
    orange: jest.fn(),
    red: jest.fn(),
  };
}

describe('runBanUserCommand', () => {
  it('passes a string identity and the existing concurrent-ban policy to the callback', async () => {
    const deps = dependencies();
    expect(await runBanUserCommand(deps)).toBe(0);
    expect(deps.findUserByEmail).toHaveBeenCalledWith('user@example.com');
    expect(deps.banViolation).toHaveBeenCalledWith({}, expect.any(Object), {
      type: ViolationTypes.CONCURRENT,
      violation_count: 20,
      user_id: '507f1f77bcf86cd799439011',
      prev_count: 0,
      duration: 120000,
    });
    expect(deps.purple).toHaveBeenCalledWith('Found user: user@example.com');
  });

  it('accepts a plain string identity and leaves command-line duration in milliseconds', async () => {
    const deps: Parameters<typeof runBanUserCommand>[0] = {
      ...dependencies(),
      args: ['user@example.com', '2'],
      findUserByEmail: async () => ({ _id: 'plain-id' }),
    };
    expect(await runBanUserCommand(deps)).toBe(0);
    expect(deps.banViolation).toHaveBeenCalledWith(
      {},
      expect.any(Object),
      expect.objectContaining({ user_id: 'plain-id', duration: 2 }),
    );
  });

  it('prompts for email and converts interactive minutes to milliseconds', async () => {
    const deps = dependencies();
    deps.args = [];
    deps.askQuestion.mockResolvedValueOnce('user@example.com').mockResolvedValueOnce('2');
    expect(await runBanUserCommand(deps)).toBe(0);
    expect(deps.askQuestion.mock.calls).toEqual([['Email:'], ['Duration (in minutes):']]);
    expect(deps.orange).toHaveBeenCalledWith('Usage: npm run ban-user <email> <duration>');
    expect(deps.banViolation).toHaveBeenCalledWith(
      {},
      expect.any(Object),
      expect.objectContaining({ duration: 120000 }),
    );
  });

  it.each(['', 'invalid', '0', '-1'])(
    'rejects invalid interactive duration %j before lookup or writes',
    async (duration) => {
      const deps = dependencies();
      deps.args = [];
      deps.askQuestion.mockResolvedValueOnce('user@example.com').mockResolvedValueOnce(duration);
      expect(await runBanUserCommand(deps)).toBe(1);
      expect(deps.red).toHaveBeenCalledWith('Error: Invalid duration!');
      expect(deps.findUserByEmail).not.toHaveBeenCalled();
      expect(deps.banViolation).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'invalid'])('rejects invalid email %j before lookup or writes', async (email) => {
    const deps = dependencies();
    deps.args = [email, '60000'];
    deps.askQuestion.mockResolvedValue('');
    expect(await runBanUserCommand(deps)).toBe(1);
    expect(deps.red).toHaveBeenCalledWith('Error: Invalid email address!');
    expect(deps.findUserByEmail).not.toHaveBeenCalled();
    expect(deps.banViolation).not.toHaveBeenCalled();
  });

  it('returns failure for an absent account without banning', async () => {
    const deps = dependencies();
    const findUserByEmail = jest.fn(async () => null);
    expect(await runBanUserCommand({ ...deps, findUserByEmail })).toBe(1);
    expect(deps.red).toHaveBeenCalledWith('Error: No user with that email was found!');
    expect(deps.banViolation).not.toHaveBeenCalled();
  });

  it('retains the empty request and no-op cookie/chainable response behavior', async () => {
    const deps = dependencies();
    await runBanUserCommand(deps);
    const [req, res] = deps.banViolation.mock.calls[0];
    expect(req).toEqual({});
    expect(res.clearCookie('refreshToken')).toBeUndefined();
    expect(res.status().json()).toBe(res);
  });

  it('propagates operational failures to the lifecycle owner', async () => {
    const deps = dependencies();
    deps.banViolation.mockRejectedValueOnce(new Error('revocation failed'));
    await expect(runBanUserCommand(deps)).rejects.toThrow('revocation failed');
  });
});
