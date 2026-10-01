const { SystemRoles } = require('librechat-data-provider');

let capturedVerifyCallback;
let capturedStrategyOptions;
const mockRunAsSystem = jest.fn((callback) => callback());
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn((opts, verifyCallback) => {
    capturedStrategyOptions = opts;
    capturedVerifyCallback = verifyCallback;
    return { name: 'jwt' };
  }),
  ExtractJwt: {
    fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor'),
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  runAsSystem: mockRunAsSystem,
}));

jest.mock('@librechat/api', () => ({
  AGENT_TRIGGER_SCOPE: 'agent_trigger',
  isTokenIssuedBeforeCredentialChange:
    jest.requireActual('@librechat/api').isTokenIssuedBeforeCredentialChange,
}));

jest.mock('~/models', () => ({
  getUserById: jest.fn(),
  updateUser: jest.fn(),
}));

const jwtLogin = require('./jwtStrategy');
const { getUserById, updateUser } = require('~/models');

function request(overrides = {}) {
  return {
    method: 'GET',
    originalUrl: '/api/user',
    headers: {},
    ...overrides,
  };
}

function invokeVerify(payload, req = request()) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(req, payload, (err, user, info) => {
      if (err) {
        return reject(err);
      }
      resolve({ user, info });
    });
  });
}

describe('jwtStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateUser.mockResolvedValue({});
    jwtLogin();
  });

  it('coerces missing idOnTheSource to null for local users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-1' },
      role: SystemRoles.USER,
    });

    const { user } = await invokeVerify({ id: 'user-1' });

    expect(user.id).toBe('user-1');
    expect(user.idOnTheSource).toBeNull();
    expect(capturedStrategyOptions.passReqToCallback).toBe(true);
  });

  it('runs globally scoped authentication reads and writes in system context', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-system' },
    });

    const { user } = await invokeVerify({ id: 'user-system' });

    expect(user).toMatchObject({ id: 'user-system', role: SystemRoles.USER });
    expect(mockRunAsSystem).toHaveBeenCalledTimes(2);
    expect(getUserById).toHaveBeenCalledWith(
      'user-system',
      '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
    );
    expect(updateUser).toHaveBeenCalledWith('user-system', { role: SystemRoles.USER });
  });

  it('preserves a stored idOnTheSource for federated users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-2' },
      role: SystemRoles.USER,
      idOnTheSource: 'entra-oid-123',
    });

    const { user } = await invokeVerify({ id: 'user-2' });

    expect(user.idOnTheSource).toBe('entra-oid-123');
  });

  it('returns false when no user is found', async () => {
    getUserById.mockResolvedValue(null);

    const { user } = await invokeVerify({ id: 'missing' });

    expect(user).toBe(false);
  });

  it('accepts a scoped trigger token only on an exact marked admission route', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-3' },
      role: SystemRoles.USER,
    });

    const { user } = await invokeVerify(
      { id: 'user-3', scope: 'agent_trigger' },
      request({
        method: 'POST',
        originalUrl: '/trusted/base/api/agents/chat/agents?source=delivery',
        headers: { 'x-lc-agent-trigger': '1' },
      }),
    );

    expect(user.id).toBe('user-3');
  });

  it.each([
    ['an unrelated route', request({ method: 'POST', originalUrl: '/api/user' })],
    [
      'a missing transport marker',
      request({ method: 'POST', originalUrl: '/api/agents/chat/agents' }),
    ],
    [
      'a non-POST request',
      request({
        method: 'GET',
        originalUrl: '/api/agents/chat/steer/deliver',
        headers: { 'x-lc-agent-trigger': '1' },
      }),
    ],
  ])('rejects a scoped trigger token on %s', async (_label, req) => {
    const { user, info } = await invokeVerify({ id: 'user-3', scope: 'agent_trigger' }, req);

    expect(user).toBe(false);
    expect(info).toEqual({ message: 'Agent trigger token is not valid for this endpoint' });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('rejects ordinary and trigger-scoped tokens while account deletion is fenced', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-3' },
      role: SystemRoles.USER,
      agentTriggerDeletionStartedAt: new Date('2026-08-17T12:00:00.000Z'),
    });

    const ordinary = await invokeVerify({ id: 'user-3' });
    const trigger = await invokeVerify(
      { id: 'user-3', scope: 'agent_trigger' },
      request({
        method: 'POST',
        originalUrl: '/api/agents/chat/steer/deliver',
        headers: { 'x-lc-agent-trigger': '1' },
      }),
    );

    expect(ordinary).toEqual({
      user: false,
      info: {
        message: 'Account deletion is in progress',
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
      },
    });
    expect(trigger).toEqual({
      user: false,
      info: {
        message: 'Account deletion is in progress',
        code: 'ACCOUNT_DELETION_IN_PROGRESS',
      },
    });
    expect(getUserById).toHaveBeenCalledWith(
      'user-3',
      '-password -__v -totpSecret -backupCodes +agentTriggerDeletionStartedAt',
    );
  });

  describe('credentialsChangedAt revocation', () => {
    /** Reset landed 500ms into second 1700000010 */
    const credentialsChangedAt = new Date(1700000010500);

    const mockUserWithStamp = (stamp) => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-reset' },
        role: SystemRoles.USER,
        credentialsChangedAt: stamp,
      });
    };

    it('rejects an access token issued before the password reset', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000009 });

      expect(user).toBe(false);
    });

    it('accepts an access token issued after the password reset', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000011 });

      expect(user.id).toBe('user-reset');
    });

    it('rejects a token whose issuing second started before the reset instant', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000010 });

      expect(user).toBe(false);
    });

    it('accepts a token issued in the same second as a reset stamped on the second boundary', async () => {
      mockUserWithStamp(new Date(1700000010000));

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000010 });

      expect(user.id).toBe('user-reset');
    });

    it('accepts a stale token when the user never changed credentials', async () => {
      getUserById.mockResolvedValue({
        _id: { toString: () => 'user-1' },
        role: SystemRoles.USER,
      });

      const { user } = await invokeVerify({ id: 'user-1', iat: 1 });

      expect(user.id).toBe('user-1');
    });

    it('rejects a token without iat once credentials have changed', async () => {
      mockUserWithStamp(credentialsChangedAt);

      const { user } = await invokeVerify({ id: 'user-reset' });

      expect(user).toBe(false);
    });

    it('honors a stamp deserialized as a string', async () => {
      mockUserWithStamp(credentialsChangedAt.toISOString());

      const { user } = await invokeVerify({ id: 'user-reset', iat: 1700000009 });

      expect(user).toBe(false);
    });
  });
});
