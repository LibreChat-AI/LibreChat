const mockInitialize = jest.fn();
const mockClose = jest.fn();
const mockDisconnect = jest.fn();
const mockRegisterUser = jest.fn();
const mockFindUser = jest.fn();
const mockCreateToken = jest.fn();
const mockSendMail = jest.fn();
const mockExit = jest.fn();
const mockLoadConfig = jest.fn();

jest.mock('module-alias', () => jest.fn());
jest.mock('mongoose', () => ({ disconnect: mockDisconnect }));
jest.mock('@librechat/data-schemas', () => ({
  createModels: () => ({ User: { findOne: mockFindUser } }),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../packages/api/src/auth/operation'),
  ...jest.requireActual('../../packages/api/src/utils/errors'),
}));
jest.mock('~/models', () => ({
  initializeAuthentication: (...args) => mockInitialize(...args),
  closeAuthentication: () => mockClose(),
}));
jest.mock('~/server/services/Config/loadCustomConfig', () => mockLoadConfig);
jest.mock('~/server/services/AuthService', () => ({
  registerUser: (...args) => mockRegisterUser(...args),
}));
jest.mock('../connect', () => jest.fn(async () => undefined));
jest.mock('../helpers', () => ({
  askQuestion: jest.fn(),
  silentExit: (...args) => mockExit(...args),
}));

let originalArgv;
let originalHandlers;
function runCli() {
  return new Promise((resolve) => {
    mockExit.mockImplementation(resolve);
    require('../create-user');
  });
}
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  originalArgv = process.argv;
  originalHandlers = new Set(process.listeners('uncaughtException'));
  process.argv = [
    'node',
    'create-user',
    'new@example.com',
    'New User',
    'new-user',
    'safe-password',
    '--email-verified=false',
  ];
  for (const name of ['purple', 'orange', 'red', 'green']) console[name] = jest.fn();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockInitialize.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockDisconnect.mockResolvedValue(undefined);
  mockLoadConfig.mockResolvedValue({ persistence: { authentication: 'postgres' } });
  mockFindUser
    .mockReset()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ emailVerified: false });
  mockRegisterUser.mockImplementation(async () => {
    await mockCreateToken();
    await mockSendMail();
    return { status: 200 };
  });
  mockCreateToken.mockResolvedValue(undefined);
  mockSendMail.mockResolvedValue(undefined);
});
afterEach(() => {
  process.argv = originalArgv;
  process
    .listeners('uncaughtException')
    .filter((handler) => !originalHandlers.has(handler))
    .forEach((handler) => process.removeListener('uncaughtException', handler));
  jest.restoreAllMocks();
});

describe('create-user authentication lifecycle', () => {
  it.each(['mongo', 'postgres'])(
    'initializes %s before registration and verification writes, then closes before exit',
    async (authentication) => {
      mockLoadConfig.mockResolvedValueOnce({ persistence: { authentication } });
      expect(await runCli()).toBe(0);
      expect(mockLoadConfig).toHaveBeenCalledWith(false, { storageSelection: true });
      expect(mockInitialize).toHaveBeenCalledWith({ persistence: { authentication } });
      expect(mockInitialize.mock.invocationCallOrder[0]).toBeLessThan(
        mockRegisterUser.mock.invocationCallOrder[0],
      );
      expect(mockInitialize.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateToken.mock.invocationCallOrder[0],
      );
      expect(mockRegisterUser).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'new@example.com', username: 'new-user' }),
        { emailVerified: false },
      );
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(mockClose).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(mockClose.mock.invocationCallOrder[0]).toBeLessThan(
        mockExit.mock.invocationCallOrder[0],
      );
    },
  );
  it('prevents account creation and mail when authentication initialization fails', async () => {
    mockInitialize.mockRejectedValueOnce(new Error('private database details'));
    expect(await runCli()).toBe(1);
    expect(mockRegisterUser).not.toHaveBeenCalled();
    expect(mockCreateToken).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('private database details');
  });
  it('closes selected storage after registration rejects', async () => {
    mockRegisterUser.mockRejectedValueOnce(new Error('private provider details'));
    expect(await runCli()).toBe(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('private provider details');
  });
  it('closes selected storage when registration returns a refusal', async () => {
    mockRegisterUser.mockResolvedValueOnce({ status: 403, message: 'Registration not allowed' });
    expect(await runCli()).toBe(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
