const mockInitialize = jest.fn();
const mockClose = jest.fn();
const mockDisconnect = jest.fn();
const mockCreateInvite = jest.fn();
const mockFindUser = jest.fn();
const mockSendEmail = jest.fn();
const mockLoadConfig = jest.fn();
const mockSilentExit = jest.fn();
const mockCreateToken = jest.fn();
const mockFindToken = jest.fn();

jest.mock('../connect', () => jest.fn(async () => undefined));
jest.mock('module-alias', () => jest.fn());
jest.mock('mongoose', () => ({ disconnect: mockDisconnect }));
jest.mock('@librechat/data-schemas', () => ({
  createModels: () => ({ User: { findOne: mockFindUser } }),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../packages/api/src/auth/operation'),
  ...jest.requireActual('../../packages/api/src/utils/errors'),
  checkEmailConfig: () => true,
  createInvite: (...args) => mockCreateInvite(...args),
}));
jest.mock('../../api/models', () => ({
  initializeAuthentication: (...args) => mockInitialize(...args),
  closeAuthentication: () => mockClose(),
  createToken: mockCreateToken,
  findToken: mockFindToken,
}));
jest.mock('~/server/services/Config/loadCustomConfig', () => mockLoadConfig);
jest.mock('../../api/server/utils', () => ({ sendEmail: (...args) => mockSendEmail(...args) }));
jest.mock('../helpers', () => ({
  askQuestion: async () => ' Invited@Example.com ',
  silentExit: (...args) => mockSilentExit(...args),
  coloredConsole: { purple: jest.fn(), orange: jest.fn(), red: jest.fn(), green: jest.fn() },
}));

let originalHandlers;
let originalArgv;

function runCli() {
  return new Promise((resolve) => {
    mockSilentExit.mockImplementation(resolve);
    expect(() => require('../invite-user')).not.toThrow();
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  originalHandlers = new Set(process.listeners('uncaughtException'));
  originalArgv = process.argv;
  process.argv = ['node', 'invite-user'];
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockInitialize.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockDisconnect.mockResolvedValue(undefined);
  mockCreateInvite.mockResolvedValue('invite-token');
  mockFindUser.mockResolvedValue(null);
  mockSendEmail.mockResolvedValue(undefined);
  mockLoadConfig.mockResolvedValue({ persistence: { authentication: 'postgres' } });
});

afterEach(() => {
  process.argv = originalArgv;
  process
    .listeners('uncaughtException')
    .filter((handler) => !originalHandlers.has(handler))
    .forEach((handler) => process.removeListener('uncaughtException', handler));
  jest.restoreAllMocks();
});

describe('Invite user CLI', () => {
  it('loads its runtime dependencies and initializes selected storage before creating an invite', async () => {
    expect(await runCli()).toBe(0);

    expect(mockInitialize).toHaveBeenCalledWith({ persistence: { authentication: 'postgres' } });
    expect(mockLoadConfig).toHaveBeenCalledWith(false, { storageSelection: true });
    expect(mockInitialize.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateInvite.mock.invocationCallOrder[0],
    );
    expect(mockCreateInvite).toHaveBeenCalledWith('invited@example.com', {
      createToken: mockCreateToken,
      findToken: mockFindToken,
    });
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockClose.mock.invocationCallOrder[0]).toBeLessThan(
      mockSilentExit.mock.invocationCallOrder[0],
    );
  });

  it('does not issue an invite when authentication storage cannot initialize', async () => {
    mockInitialize.mockRejectedValueOnce(new Error('sensitive-postgres-connection'));

    expect(await runCli()).toBe(1);

    expect(mockCreateInvite).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('sensitive-postgres-connection');
  });

  it('closes selected storage after invitation delivery fails without logging provider details', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('sensitive-invitation-payload'));

    expect(await runCli()).toBe(1);

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(console.error.mock.calls)).not.toContain('sensitive-invitation-payload');
  });

  it('closes storage when an existing account prevents invitation', async () => {
    mockFindUser.mockResolvedValueOnce({ _id: 'existing-user' });

    expect(await runCli()).toBe(1);

    expect(mockCreateInvite).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
