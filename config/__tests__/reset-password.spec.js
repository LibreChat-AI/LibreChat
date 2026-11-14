const mockFindUser = jest.fn();
const mockMethods = {
  initializeAuthentication: jest.fn(),
  closeAuthentication: jest.fn(),
  updateUser: jest.fn(),
  deletePasskeysByUser: jest.fn(),
  deleteAllUserSessions: jest.fn(),
  awaitAuthUserDocEviction: jest.fn(),
};
const mockDisconnect = jest.fn();
const mockLoadCustomConfig = jest.fn();
const mockAskSilentQuestion = jest.fn();
const mockRestamp = jest.fn();

jest.mock('module-alias', () => jest.fn());
jest.mock('mongoose', () => ({ disconnect: mockDisconnect }));
jest.mock('bcryptjs', () => ({
  genSalt: jest.fn(async () => 'salt'),
  hash: jest.fn(async () => 'new-password-hash'),
}));
jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_query, callback) => callback('user@example.com'),
    close: jest.fn(),
  }),
}));
jest.mock('@librechat/data-schemas', () => ({
  createModels: () => ({ User: { findOne: mockFindUser } }),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../packages/api/src/auth/passwordResetUpdate'),
  ...jest.requireActual('../../packages/api/src/utils/errors'),
  ...jest.requireActual('../../packages/api/src/auth/operation'),
  restampRetirementCutoff: (...args) => mockRestamp(...args),
}));
jest.mock('~/models', () => mockMethods);
jest.mock('~/server/services/Config/loadCustomConfig', () => mockLoadCustomConfig);
jest.mock('../helpers', () => ({
  askSilentQuestion: (...args) => mockAskSilentQuestion(...args),
}));
jest.mock('../connect', () => jest.fn(async () => undefined));

function runCli() {
  return new Promise((resolve) => {
    jest.spyOn(process, 'exit').mockImplementation(resolve);
    require('../reset-password');
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockFindUser.mockResolvedValue({ _id: 'mongo-user-id' });
  mockLoadCustomConfig.mockResolvedValue({ persistence: { authentication: 'postgres' } });
  mockMethods.initializeAuthentication.mockResolvedValue(undefined);
  mockMethods.closeAuthentication.mockResolvedValue(undefined);
  mockMethods.updateUser.mockResolvedValue({ _id: 'mongo-user-id' });
  mockMethods.deletePasskeysByUser.mockResolvedValue(2);
  mockMethods.deleteAllUserSessions.mockResolvedValue({ deletedCount: 1 });
  mockMethods.awaitAuthUserDocEviction.mockResolvedValue(undefined);
  mockDisconnect.mockResolvedValue(undefined);
  mockAskSilentQuestion.mockResolvedValue('new-password');
  mockRestamp.mockImplementation((field, _userId, stampedAt, write) =>
    write({ [field]: new Date() }, { [field]: stampedAt }),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reset-password authentication storage wiring', () => {
  it.each(['deletePasskeys', 'deleteSessions', 'restamp', 'evict'])(
    'preserves the full retirement sequence when %s fails',
    async (failing) => {
      const failure = new Error('retirement failed');
      if (failing === 'deletePasskeys')
        mockMethods.deletePasskeysByUser.mockRejectedValueOnce(failure);
      if (failing === 'deleteSessions')
        mockMethods.deleteAllUserSessions.mockRejectedValueOnce(failure);
      if (failing === 'restamp') {
        mockMethods.updateUser
          .mockResolvedValueOnce({ _id: 'mongo-user-id' })
          .mockRejectedValueOnce(failure);
      }
      if (failing === 'evict') mockMethods.awaitAuthUserDocEviction.mockRejectedValueOnce(failure);

      expect(await runCli()).toBe(1);

      const calls = [
        ...mockMethods.updateUser.mock.invocationCallOrder.map((order, index) => ({
          order,
          name: mockMethods.updateUser.mock.calls[index][1].password ? 'writePassword' : 'restamp',
        })),
        {
          order: mockMethods.deletePasskeysByUser.mock.invocationCallOrder[0],
          name: 'deletePasskeys',
        },
        {
          order: mockMethods.deleteAllUserSessions.mock.invocationCallOrder[0],
          name: 'deleteSessions',
        },
        { order: mockMethods.awaitAuthUserDocEviction.mock.invocationCallOrder[0], name: 'evict' },
      ];
      expect(calls.sort((a, b) => a.order - b.order).map(({ name }) => name)).toEqual([
        'writePassword',
        'deletePasskeys',
        'deleteSessions',
        'restamp',
        'evict',
      ]);
    },
  );

  it('initializes selected storage before changing credentials and closes it before exiting', async () => {
    expect(await runCli()).toBe(0);

    expect(mockLoadCustomConfig).toHaveBeenCalledWith(false, { storageSelection: true });
    expect(mockMethods.initializeAuthentication).toHaveBeenCalledWith({
      persistence: { authentication: 'postgres' },
    });
    expect(mockMethods.initializeAuthentication.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.updateUser.mock.invocationCallOrder[0],
    );
    expect(mockMethods.deletePasskeysByUser).toHaveBeenCalledWith('mongo-user-id');
    expect(mockMethods.deleteAllUserSessions).toHaveBeenCalledWith('mongo-user-id');
    expect(mockMethods.updateUser).toHaveBeenCalledWith(
      'mongo-user-id',
      expect.objectContaining({
        password: 'new-password-hash',
        credentialsChangedAt: expect.any(Date),
        pendingTotpSecret: null,
        pendingBackupCodes: [],
      }),
      {},
      { preserveExpiresAt: true },
    );
    expect(mockMethods.deleteAllUserSessions.mock.invocationCallOrder[0]).toBeLessThan(
      mockRestamp.mock.invocationCallOrder[0],
    );
    expect(mockRestamp.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.awaitAuthUserDocEviction.mock.invocationCallOrder[0],
    );
    expect(mockMethods.closeAuthentication).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockMethods.closeAuthentication.mock.invocationCallOrder[0]).toBeLessThan(
      process.exit.mock.invocationCallOrder[0],
    );
    expect(console.log).toHaveBeenCalledWith('Removed 2 passkey(s); the user must enroll again.');
  });

  it('awaits storage readiness before looking up the account', async () => {
    let ready;
    mockMethods.initializeAuthentication.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const completion = runCli();
    await new Promise(setImmediate);

    expect(mockFindUser).not.toHaveBeenCalled();
    expect(mockMethods.updateUser).not.toHaveBeenCalled();
    ready();
    expect(await completion).toBe(0);
  });

  it('does not change credentials when the selected backend cannot initialize', async () => {
    mockMethods.initializeAuthentication.mockRejectedValueOnce(
      new Error('postgres://sensitive-host/password'),
    );

    expect(await runCli()).toBe(1);

    expect(mockMethods.updateUser).not.toHaveBeenCalled();
    expect(mockMethods.deletePasskeysByUser).not.toHaveBeenCalled();
    expect(mockMethods.deleteAllUserSessions).not.toHaveBeenCalled();
    expect(mockMethods.closeAuthentication).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('Authentication operation failed.', {
      type: 'Error',
    });
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('sensitive-host');
  });

  it('attempts every retirement step after passkey revocation fails and exits nonzero', async () => {
    mockMethods.deletePasskeysByUser.mockRejectedValueOnce(new Error('sensitive-passkey-data'));

    expect(await runCli()).toBe(1);

    expect(mockMethods.deleteAllUserSessions).toHaveBeenCalledWith('mongo-user-id');
    expect(mockRestamp).toHaveBeenCalledTimes(1);
    expect(mockMethods.awaitAuthUserDocEviction).toHaveBeenCalledWith('mongo-user-id');
    expect(mockMethods.closeAuthentication).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalledWith('Password successfully reset!');
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('sensitive-passkey-data');
  });

  it('settles the retirement cutoff and cache after session revocation fails', async () => {
    mockMethods.deleteAllUserSessions.mockRejectedValueOnce(new Error('storage unavailable'));

    expect(await runCli()).toBe(1);

    expect(mockRestamp).toHaveBeenCalledTimes(1);
    expect(mockMethods.awaitAuthUserDocEviction).toHaveBeenCalledWith('mongo-user-id');
    expect(mockMethods.closeAuthentication).toHaveBeenCalledTimes(1);
  });

  it('closes storage when the account does not exist', async () => {
    mockFindUser.mockResolvedValueOnce(null);

    expect(await runCli()).toBe(1);

    expect(mockMethods.updateUser).not.toHaveBeenCalled();
    expect(mockMethods.closeAuthentication).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('exits nonzero when pool cleanup fails', async () => {
    mockMethods.closeAuthentication.mockRejectedValueOnce(new Error('sensitive-pool-state'));

    expect(await runCli()).toBe(1);

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith('Error closing authentication storage.');
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('sensitive-pool-state');
  });
});
